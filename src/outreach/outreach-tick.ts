/**
 * Outreach tick — the scheduler. Runs from /api/cron/tick (and is safe to call
 * from a script). One pass:
 *   1. Poll fallbacks (recover missed webhooks): invite acceptances + replies.
 *   2. If within the send window and not globally paused, claim due threads via
 *      FOR UPDATE SKIP LOCKED and advance each one (respecting the send budget).
 *   3. Light staleness sweep — archive DRAFT threads the owner never confirmed.
 *
 * Claiming sets nextActionAt=NULL so an overlapping tick can't double-process.
 * A thread that throws is rescheduled to now+5min for an automatic retry.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { config } from "@/config";
import { getSettings } from "@/lib/settings";
import { getSendBudget, isWithinSendWindow } from "./limits";
import { processThread, markThreadReplied, type SendBudgetMut } from "./thread-worker";
import { resetActiveRoleCache } from "./active-role";
import { replenishOutreach } from "./replenish";
import { maybeAutoResume } from "./safety";
import { isNegativeReply } from "./classify-reply";
import { recomputeOutreachState } from "@/status/outreach-state";
import {
  listChatMessages,
  listSentInvitations,
  fetchProfile,
  isAlreadyConnected,
} from "@/unipile/client";
import { sendReplyAlert } from "@/email/digest";

// Kept comfortably servable within the 60s function budget — each thread does a
// live LinkedIn call plus DB writes, so 50 could time out mid-batch and strand
// the tail. Claimed threads self-heal (see claimDueThreads) but a smaller batch
// means far fewer need to.
const MAX_PER_TICK = 15;
const RETRY_DELAY_MS = 5 * 60 * 1000;
// A claimed thread is pushed this far into the future instead of being nulled, so
// if the function dies before processing it the next tick re-claims it.
const CLAIM_RETRY_MS = 15 * 60 * 1000;
// A pending-send marker older than this is from a crashed send — reclaim it.
const PENDING_SEND_STALE_MS = 10 * 60 * 1000;

export interface TickResult {
  paused?: boolean;
  outsideWindow?: boolean;
  capped?: boolean;
  processed: number;
  failed: number;
  claimed: number;
  pollAccepted: number;
  pollReplied: number;
  staleArchived: number;
  replenished: number;
}

export async function runOutreachTick(): Promise<TickResult> {
  // Lift a transient (rate-limit) pause once its cooldown elapsed. updateSettings
  // refreshes the cache, so the getSettings below sees the resumed state.
  await maybeAutoResume().catch((e) => console.error("[tick] maybeAutoResume failed:", e));
  resetActiveRoleCache(); // fresh open-job memo for this pass's closed-role re-pitches
  const settings = await getSettings();
  const base: TickResult = {
    processed: 0, failed: 0, claimed: 0, pollAccepted: 0, pollReplied: 0, staleArchived: 0, replenished: 0,
  };

  // Recover threads stranded mid-send by a crash: pendingSendKey was written but
  // never cleared and nextActionAt was already nulled by the claim, so nothing
  // would ever pick them up again. Clear the marker and requeue them shortly.
  await reclaimStalePendingSends().catch((e) => console.error("[tick] reclaimStalePendingSends failed:", e));

  // Invite ACCEPTANCES come from the `users.new_relation` webhook (Unipile's
  // ~8h relations-sync push) — the source of truth. We do NOT poll for them
  // every tick (that pull pattern reads as bot scraping and risks the account).
  // The reconcile below runs AT MOST once per UTC day as a missed-webhook
  // safety net, and self-skips on every other tick.
  base.pollAccepted = await reconcileInviteAcceptances().catch((e) => {
    console.error("[tick] reconcileInviteAcceptances failed:", e);
    return 0;
  });
  // Replies still poll as a fallback — far lower volume (only active MESSAGED
  // threads) and the message_received webhook can miss.
  base.pollReplied = await pollReplies().catch((e) => {
    console.error("[tick] pollReplies failed:", e);
    return 0;
  });
  base.staleArchived = await sweepStaleDrafts(config.staleness.archiveAfterDays).catch(() => 0);

  if (settings.outreach.globalPause) {
    return { ...base, paused: true };
  }

  // Top up jobs whose invite pipeline has open slots (accepted < target). This
  // only QUEUES fresh threads — it runs regardless of the send window because the
  // claim loop below (and on later ticks) still gates the actual sends.
  base.replenished = await replenishOutreach(settings)
    .then((r) => r.queued)
    .catch((e) => {
      console.error("[tick] replenishOutreach failed:", e);
      return 0;
    });

  if (!isWithinSendWindow(settings)) {
    return { ...base, outsideWindow: true };
  }

  const budget = await getSendBudget(settings);
  const budgetMut: SendBudgetMut = { invitesLeft: budget.invitesLeft, dmsLeft: budget.dmsLeft };
  if (budgetMut.invitesLeft <= 0 && budgetMut.dmsLeft <= 0) {
    return { ...base, capped: true };
  }

  const claimedIds = await claimDueThreads(MAX_PER_TICK);
  base.claimed = claimedIds.length;

  for (const threadId of claimedIds) {
    try {
      await processThread(threadId, budgetMut, settings);
      base.processed++;
    } catch (err) {
      base.failed++;
      console.error(`[tick] thread ${threadId} failed:`, (err as Error).message);
      await prisma.channelThread
        .updateMany({
          where: { id: threadId, status: { in: ["PENDING", "ACTIVE"] } },
          data: { nextActionAt: new Date(Date.now() + RETRY_DELAY_MS) },
        })
        .catch(() => {});
    }
  }

  return base;
}

/**
 * Manual scoped send for the dashboard "Send requests" bulk action.
 * Fires the QUEUED threads for the given jobs NOW — bypasses the send window
 * (the owner explicitly clicked send) but still respects the globalPause kill
 * switch and the daily/weekly rate budget (account safety).
 */
export async function sendForJobs(
  jobIds: string[],
  opts: { withNote?: boolean; ignoreInviteLimit?: boolean; ignoreDmLimit?: boolean; only?: "invite" | "dm" } = {},
): Promise<{
  sent: number; failed: number; paused?: boolean; capped?: boolean; noThreads?: boolean;
}> {
  if (jobIds.length === 0) return { sent: 0, failed: 0 };
  resetActiveRoleCache(); // fresh open-job memo for this pass's closed-role re-pitches
  const settings = await getSettings();
  if (settings.outreach.globalPause) return { sent: 0, failed: 0, paused: true };

  const budget = await getSendBudget(settings);
  // Manual sends bypass BOTH daily and weekly invite caps — the user explicitly
  // chose these jobs. Our weekly cap is a conservative self-limit, not LinkedIn's
  // hard rate limit; LinkedIn's API will reject if truly throttled.
  const effectiveInvitesLeft = opts.ignoreInviteLimit
    ? Number.MAX_SAFE_INTEGER
    : budget.invitesLeft;
  // Manual sends bypass the DM cap too: the daily cap is a conservative pacing
  // limit for the automatic tick, but when the owner explicitly clicks "Send
  // DMs now" they mean it — otherwise a spent DM budget silently fires only
  // invites and never the direct-DM (connection) threads they actually wanted.
  const effectiveDmsLeft = opts.ignoreDmLimit
    ? Number.MAX_SAFE_INTEGER
    : budget.dmsLeft;
  const budgetMut: SendBudgetMut = { invitesLeft: effectiveInvitesLeft, dmsLeft: effectiveDmsLeft };
  // For auto sends: bail early when both invite and DM budgets are zero.
  // For manual sends: always proceed — thread workers handle per-type budget checks.
  if (!opts.ignoreInviteLimit && budgetMut.invitesLeft <= 0 && budgetMut.dmsLeft <= 0) {
    return { sent: 0, failed: 0, capped: true };
  }

  const outreaches = await prisma.outreach.findMany({
    where: { jobId: { in: jobIds }, threadId: { not: null } },
    select: { threadId: true },
  });
  const threadIds = outreaches.map((o) => o.threadId!).filter(Boolean);
  if (threadIds.length === 0) return { sent: 0, failed: 0, noThreads: true };

  // Claim threads that need action now:
  //   • PENDING (QUEUED/DRAFT) — haven't sent yet, manual send should fire them
  //   • ACTIVE with nextActionAt <= now — already past their scheduled action
  // Exclude ACTIVE threads whose nextActionAt is in the future (e.g. INVITE_PENDING
  // waiting 7 days for acceptance, or CONNECTED/MESSAGED waiting for a window).
  // Claiming those early would mis-trigger the timeout logic.
  const now = new Date();
  const claimableAll = await prisma.channelThread.findMany({
    where: {
      id: { in: threadIds },
      OR: [
        { status: "PENDING" },
        { status: "ACTIVE", nextActionAt: { lte: now } },
      ],
    },
    select: { id: true, providerState: true },
  });
  // Optional split: "invite" fires only QUEUED (connection-invite) threads,
  // "dm" fires only CONNECTED (direct-DM) threads. Without `only`, both go — and
  // we never touch the phases we're not sending, so their nextActionAt is left
  // intact for the tick rather than nulled-and-stranded.
  const claimable = opts.only
    ? claimableAll.filter((c) => {
        const ph = (c.providerState as { phase?: string } | null)?.phase;
        return opts.only === "invite" ? ph === "QUEUED" : ph === "CONNECTED";
      })
    : claimableAll;
  if (claimable.length === 0) return { sent: 0, failed: 0, noThreads: true };
  await prisma.channelThread.updateMany({
    where: { id: { in: claimable.map((c) => c.id) } },
    data: { nextActionAt: null },
  });

  // Connection note is opt-in for the manual flow. When the owner chose "with
  // note", copy the drafted note into the live connectionNote so doSendInvite
  // includes it; otherwise leave it empty (bare invite).
  if (opts.withNote) {
    for (const c of claimable) {
      const ps = (c.providerState as Record<string, unknown> | null) ?? {};
      const draft = (ps.connectionNoteDraft as string) ?? "";
      if (draft && !ps.connectionNote) {
        await prisma.channelThread
          .updateMany({ where: { id: c.id }, data: { providerState: { ...ps, connectionNote: draft } } })
          .catch(() => {});
      }
    }
  }

  let sent = 0, failed = 0;
  for (const { id } of claimable) {
    if (budgetMut.invitesLeft <= 0 && budgetMut.dmsLeft <= 0) {
      await prisma.channelThread.updateMany({ where: { id }, data: { nextActionAt: new Date() } }).catch(() => {});
      continue;
    }
    try {
      await processThread(id, budgetMut, settings);
      sent++;
    } catch (err) {
      failed++;
      console.error(`[send] thread ${id} failed:`, (err as Error).message);
      await prisma.channelThread
        .updateMany({ where: { id, status: { in: ["PENDING", "ACTIVE"] } }, data: { nextActionAt: new Date(Date.now() + RETRY_DELAY_MS) } })
        .catch(() => {});
    }
  }
  // Don't report capped for manual sends — the user already knew they were at the
  // limit; they clicked Send intentionally. capped flag only matters for the cron.
  const wasCapped = !opts.ignoreInviteLimit && budgetMut.invitesLeft <= 0;
  return { sent, failed, ...(wasCapped ? { capped: true } : {}) };
}

/**
 * Clear the leftover send queue for the given jobs — used by the manual "Send
 * now" fast-track once the owner has actioned the jobs themselves. Archives only
 * threads that haven't sent anything yet (phase QUEUED/DRAFT) AND are still idle
 * (nextActionAt IS NULL). Threads that were rescheduled to the future because the
 * invite budget was exhausted during this same send will have nextActionAt set and
 * are left alone — the next cron tick will send them. Threads already at
 * INVITE_PENDING and beyond are also left alone.
 */
export async function clearQueuedForJobs(jobIds: string[]): Promise<number> {
  if (jobIds.length === 0) return 0;
  const outreaches = await prisma.outreach.findMany({
    where: { jobId: { in: jobIds }, threadId: { not: null } },
    select: { threadId: true },
  });
  const threadIds = outreaches.map((o) => o.threadId!).filter(Boolean);
  if (threadIds.length === 0) return 0;

  const res = await prisma.channelThread.updateMany({
    where: {
      id: { in: threadIds },
      status: "PENDING",
      nextActionAt: null, // skip threads already rescheduled by a budget-exhausted send
      OR: [
        { providerState: { path: ["phase"], equals: "QUEUED" } },
        { providerState: { path: ["phase"], equals: "DRAFT" } },
      ],
    },
    data: {
      status: "ARCHIVED",
      archivedAt: new Date(),
      archivedReason: "Cleared after manual send",
      nextActionAt: null,
    },
  });
  for (const jobId of jobIds) await recomputeOutreachState(jobId).catch(() => {});
  return res.count;
}

// ─── Claim ────────────────────────────────────────────────────────────────────

/**
 * Claim due threads, FAIR-SHARE ACROSS JOBS — discovery queues people faster than
 * the daily invite cap can send them, so neither FIFO (oldest crowd out) nor pure
 * score (top jobs drain the whole budget) is right. Instead we round-robin:
 *
 *   1. post-acceptance actions first (CONNECTED/MESSAGED) — someone already
 *      engaged, so send their DM/follow-up before any new invite (separate budget,
 *      so this never starves invites);
 *   2. then by within-job rank (ROW_NUMBER per job) — every job's 1st candidate is
 *      claimed before any job's 2nd, so the daily budget spreads across MANY jobs
 *      instead of going deep on a few;
 *   3. job aiScore breaks ties within a round (better-fit roles go first);
 *   4. oldest-queued (nextActionAt) as the final tiebreak.
 *
 * Budget-exhausted claims are rescheduled by the worker, so nothing is lost. No
 * FOR UPDATE/SKIP LOCKED is needed — withCronLock serializes ticks and the
 * atomic bump of nextActionAt out of the due window is itself the claim guard (a
 * window function also can't coexist with row locking in Postgres).
 *
 * The claim pushes nextActionAt to now+CLAIM_RETRY_MS (not NULL): if the 60s
 * function dies mid-batch, an unprocessed claimed thread self-heals — the next
 * tick re-claims it once the window passes. A successfully processed thread has
 * its nextActionAt advanced (or nulled for terminal states) by the worker, so the
 * retry marker never fires for work that actually completed.
 */
async function claimDueThreads(limit: number): Promise<string[]> {
  const now = new Date();
  const reclaimAt = new Date(now.getTime() + CLAIM_RETRY_MS);
  try {
    const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      WITH ranked AS (
        SELECT
          ct.id,
          (CASE WHEN (ct."providerState"->>'phase') IN ('CONNECTED','MESSAGED') THEN 0 ELSE 1 END) AS post_accept,
          ROW_NUMBER() OVER (PARTITION BY o."jobId" ORDER BY ct."nextActionAt" ASC, ct.id) AS job_rank,
          j."aiScore" AS score
        FROM "ChannelThread" ct
        LEFT JOIN "Outreach" o ON o.id = ct."outreachId"
        LEFT JOIN "Job" j ON j.id = o."jobId"
        WHERE ct.status IN ('PENDING', 'ACTIVE')
          AND ct."nextActionAt" IS NOT NULL
          AND ct."nextActionAt" <= ${now}
      ),
      claimed AS (
        UPDATE "ChannelThread"
        SET "nextActionAt" = ${reclaimAt}
        WHERE id IN (
          SELECT id FROM ranked
          ORDER BY post_accept ASC, job_rank ASC, score DESC NULLS LAST
          LIMIT ${limit}
        )
        RETURNING id
      )
      SELECT id FROM claimed
    `);
    return rows.map((r) => r.id);
  } catch (err) {
    console.error("[tick] claim failed:", err);
    return [];
  }
}

/**
 * Reclaim threads stranded mid-send by a crash. markPendingSend writes
 * pendingSendKey/pendingSendStartedAt BEFORE the provider call; a crash between
 * that write and commitSend leaves the marker set with nextActionAt already
 * nulled by the claim — so nothing ever reprocesses the thread. Clear the marker
 * and requeue it a few minutes out.
 */
async function reclaimStalePendingSends(): Promise<number> {
  const cutoff = new Date(Date.now() - PENDING_SEND_STALE_MS);
  const res = await prisma.channelThread.updateMany({
    where: {
      status: { in: ["PENDING", "ACTIVE"] },
      pendingSendStartedAt: { lt: cutoff },
    },
    data: {
      pendingSendKey: null,
      pendingSendStartedAt: null,
      nextActionAt: new Date(Date.now() + 3 * 60 * 1000),
    },
  });
  if (res.count > 0) console.log(`[tick] reclaimStalePendingSends: requeued ${res.count} stranded thread(s)`);
  return res.count;
}

// ─── Daily reconcile: missed invite acceptances ──────────────────────────────

/**
 * Invite acceptances are handled by the `users.new_relation` webhook
 * (app/api/webhooks/unipile/route.ts) — Unipile pushes accepted connections on
 * its ~8h relations-sync cadence. This reconcile is ONLY a missed-webhook safety
 * net and runs AT MOST once per UTC day: polling the sent-invitations / profile
 * endpoints every 30-min tick reads as bot scraping and risks the account.
 *
 * The once-a-day slot is claimed via a WebhookEvent marker row (unique id) — the
 * first tick of the day claims it, every other tick that day no-ops. Acceptance
 * is confirmed against the real profile (1st-degree) before advancing, never
 * inferred from mere absence in the sent list.
 */
async function reconcileInviteAcceptances(): Promise<number> {
  const accountId = config.owner.linkedinAccountId;
  if (!accountId) return 0;

  // Claim today's slot. If the marker already exists, another tick ran it today.
  const dayKey = `reconcile:invite-accept:${new Date().toISOString().slice(0, 10)}`;
  try {
    await prisma.webhookEvent.create({
      data: { id: dayKey, provider: "internal", eventType: "invite-reconcile" },
    });
  } catch {
    return 0; // already reconciled today
  }

  const pending = await prisma.channelThread.findMany({
    where: { status: "ACTIVE", providerState: { path: ["phase"], equals: "INVITE_PENDING" } },
    select: { id: true, candidateProviderId: true, providerState: true, outreachId: true },
  });
  if (pending.length === 0) return 0;

  // limit=100 (Unipile rejects higher). null => fetch failed: do NOT infer.
  const sent = await listSentInvitations(accountId, 100);
  if (sent === null) {
    console.warn("[tick] reconcileInviteAcceptances: sent-invitations fetch failed — skipping today");
    return 0;
  }
  const stillPending = new Set(
    sent.flatMap((i) => [i.invitedUserId, i.invitedUserPublicId].filter((x): x is string => !!x))
  );

  // Cap profile fetches per run so a large pending backlog can't turn the daily
  // reconcile into a profile-scraping burst. Leftovers get checked tomorrow.
  const MAX_PROFILE_CHECKS = 15;
  let checks = 0;
  let accepted = 0;
  for (const t of pending) {
    if (!t.candidateProviderId) continue;
    if (stillPending.has(t.candidateProviderId)) continue; // still awaiting acceptance

    if (checks >= MAX_PROFILE_CHECKS) {
      console.log(`[tick] reconcileInviteAcceptances: hit ${MAX_PROFILE_CHECKS}-profile cap — rest re-checked tomorrow`);
      break;
    }
    checks++;

    // Absent from the sent list ≠ accepted (could be withdrawn/expired/paginated).
    // Confirm a real 1st-degree connection before advancing — otherwise the DM
    // fails with "Subscription required" / "Recipient cannot be reached".
    let connected = false;
    try {
      connected = isAlreadyConnected(await fetchProfile(accountId, t.candidateProviderId));
    } catch {
      continue; // re-check tomorrow / let the 7-day timeout handle it
    }
    if (!connected) continue;

    const res = await prisma.channelThread.updateMany({
      where: { id: t.id, status: "ACTIVE", providerState: { path: ["phase"], equals: "INVITE_PENDING" } },
      data: {
        providerState: { ...(t.providerState as object), phase: "CONNECTED" },
        nextActionAt: new Date(),
      },
    });
    if (res.count > 0) {
      accepted++;
      const jobId = await jobForOutreach(t.outreachId);
      if (jobId) await recomputeOutreachState(jobId).catch(() => {});
    }
  }
  if (accepted > 0) console.log(`[tick] reconcileInviteAcceptances: ${accepted} missed acceptance(s) → CONNECTED`);
  return accepted;
}

// ─── Poll fallback: replies ─────────────────────────────────────────────────

async function pollReplies(): Promise<number> {
  const accountId = config.owner.linkedinAccountId;
  if (!accountId) return 0;

  // Include PAUSED — a sibling paused by the one-human rule can still receive a
  // reply, and that reply should flip it to REPLIED (markThreadReplied handles
  // PAUSED in its guard).
  const active = await prisma.channelThread.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED"] }, providerChatId: { not: null }, lastMessageAt: { not: null } },
    select: {
      id: true,
      providerChatId: true,
      lastMessageAt: true,
      outreach: { include: { job: true, contact: true } },
    },
  });
  if (active.length === 0) return 0;

  // Bound the work: this poll is a missed-webhook fallback, not the primary
  // reply channel, and it runs BEFORE the send phase inside the same 60s
  // function budget. Sequential-unbounded here starves sends as conversation
  // count grows. Most-recent conversations are the likeliest to have replies;
  // older ones are still covered by the webhook and by later ticks.
  const POLL_CAP = 40;
  const POLL_CONCURRENCY = 5;
  const toPoll = active
    .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0))
    .slice(0, POLL_CAP);

  let replied = 0;
  for (let i = 0; i < toPoll.length; i += POLL_CONCURRENCY) {
    const chunk = toPoll.slice(i, i + POLL_CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(async (t) => {
      if (!t.providerChatId || !t.lastMessageAt) return false;
      const messages = await listChatMessages(accountId, t.providerChatId, 5);
      const inbound = messages.find((m) => !m.fromMe && m.date && new Date(m.date) > t.lastMessageAt!);
      if (!inbound) return false;
      await handleInboundReply(t.id, inbound.text, t.outreach);
      return true;
    }));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) replied++;
      else if (r.status === "rejected") console.error("[tick] pollReplies thread failed:", r.reason);
    }
  }
  if (replied > 0) console.log(`[tick] pollReplies: ${replied} new replies`);
  return replied;
}

// ─── Shared reply handling (used by poll + webhook) ──────────────────────────

type OutreachWithJobContact = Prisma.OutreachGetPayload<{ include: { job: true; contact: true } }> | null;

export async function handleInboundReply(
  threadId: string,
  messageText: string,
  outreach: OutreachWithJobContact,
): Promise<void> {
  const negative = isNegativeReply(messageText);
  const transitioned = await markThreadReplied(threadId, { negative });

  if (outreach?.job) {
    await recomputeOutreachState(outreach.job.id).catch(() => {});
    // Record the inbound + fire the alert ONLY on the first transition. The poll
    // loop and the webhook both land here for the same reply; without this guard
    // the owner gets two identical alerts and two INBOUND message rows.
    if (transitioned) {
      await prisma.threadMessage
        .create({
          data: { threadId, direction: "INBOUND", kind: "INBOUND_MSG", body: messageText.slice(0, 4000) },
        })
        .catch(() => {});
      // Fire the reply-alert email (skip if it's a clear negative? No — owner still
      // wants to know, but we note it).
      await sendReplyAlert({
        contactName: outreach.contact.name,
        contactTitle: outreach.contact.title ?? "",
        company: outreach.job.company,
        role: outreach.job.role,
        messageText: negative ? `${messageText}\n\n(Auto-detected as a likely "no" — sequence stopped.)` : messageText,
        linkedinChatUrl: outreach.contact.linkedinUrl,
        jobId: outreach.job.id,
      }).catch((e) => console.error("[tick] reply alert email failed:", e));
    }
  }
}

// ─── Staleness sweep ─────────────────────────────────────────────────────────

/** Archive DRAFT threads the owner never confirmed after `days`. */
async function sweepStaleDrafts(days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const stale = await prisma.channelThread.findMany({
    where: {
      status: "PENDING",
      providerState: { path: ["phase"], equals: "DRAFT" },
      createdAt: { lt: cutoff },
    },
    select: { id: true, outreachId: true },
  });
  for (const t of stale) {
    await prisma.channelThread.updateMany({
      where: { id: t.id, status: { not: "ARCHIVED" } },
      data: { status: "ARCHIVED", archivedAt: new Date(), archivedReason: "Draft never confirmed", nextActionAt: null },
    });
    const jobId = await jobForOutreach(t.outreachId);
    if (jobId) await recomputeOutreachState(jobId).catch(() => {});
  }
  return stale.length;
}

async function jobForOutreach(outreachId: string | null): Promise<string | null> {
  if (!outreachId) return null;
  const o = await prisma.outreach.findUnique({ where: { id: outreachId }, select: { jobId: true } });
  return o?.jobId ?? null;
}
