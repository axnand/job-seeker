/**
 * Thread worker — advances ONE ChannelThread by exactly one step per tick.
 * Adapted from Hirro's thread-worker for the single-account, connection-first
 * job-seeker model. Crash/race machinery is preserved:
 *
 *   • pending-send marker written BEFORE the provider call (crash forensics)
 *   • status-guarded commit (a reply webhook flipping us to REPLIED mid-send
 *     can't be clobbered; if 0 rows update, the message record is skipped too)
 *   • circuit breaker — archive after N consecutive failures
 *   • already-connected / invite-already-pending / no-connection error handling
 *   • INVITE_PENDING timeout → re-fetch profile for a silent acceptance before
 *     cancelling the invite and archiving
 *
 * Phases (providerState.phase): QUEUED → INVITE_PENDING → CONNECTED → MESSAGED
 * → (REPLIED | archived); an existing 1st-degree connection starts at CONNECTED.
 * Threads are created with nextActionAt=now and auto-send on the next tick (no
 * manual review gate) — the owner can also fire them early via the Send buttons.
 */

import { prisma } from "@/lib/prisma";
import { config } from "@/config";
import { getSettings, type AppSettingsData } from "@/lib/settings";
import {
  sendInvitation,
  startChat,
  sendChatMessage,
  listSentInvitations,
  cancelInvitation,
  fetchProfile,
  isAlreadyConnected,
  type MessageAttachment,
} from "@/unipile/client";
import { downloadResume } from "@/lib/s3";
import { renderMessages } from "@/outreach/message-writer";
import { resolveActiveRole } from "@/outreach/active-role";
import { recomputeOutreachState } from "@/status/outreach-state";
import { handleSendError } from "./safety";
import { nextSendWindowOpen } from "./limits";
import { isCompanyBlacklisted } from "@/sources/normalize";

const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Thrown by processThread when a distress signal (429 / account_restricted) trips
 * the global pause. The batch loop (runOutreachTick / sendForJobs) MUST catch this
 * and STOP — otherwise every remaining claimed thread makes one more live call to
 * the account that just signalled distress, the exact thing the pause prevents.
 */
export class OutreachPausedError extends Error {
  constructor() {
    super("outreach paused (account distress signal)");
    this.name = "OutreachPausedError";
  }
}

export interface SendBudgetMut {
  invitesLeft: number;
  dmsLeft: number;
}

interface ProviderState {
  phase?: string;
  connectionNote?: string;
  firstDm?: string;
  followup?: string;
  inviteSentAt?: string;
  negativeReply?: boolean;
}

// ─── Guarded primitives ───────────────────────────────────────────────────────

async function guardedThreadUpdate(threadId: string, data: Record<string, unknown>): Promise<boolean> {
  const res = await prisma.channelThread.updateMany({
    where: { id: threadId, status: { in: ["PENDING", "ACTIVE"] } },
    data,
  });
  return res.count > 0;
}

/** Clear the pending-send marker after a provider call that definitively did NOT
 *  send (threw before commit), so the next tick can re-claim immediately instead
 *  of waiting for the ~10-min stale-pending reclaim sweep. */
async function clearPendingSend(threadId: string): Promise<void> {
  await prisma.channelThread
    .updateMany({ where: { id: threadId }, data: { pendingSendKey: null, pendingSendStartedAt: null } })
    .catch(() => {});
}

async function markPendingSend(threadId: string): Promise<string | null> {
  const key = crypto.randomUUID();
  // True compare-and-swap: only claim when NO send is already in flight
  // (pendingSendKey IS NULL). A thread mid-send can't be claimed a second time,
  // so an overlapping worker can't fire the same invite/DM twice. The reclaim
  // sweep in the tick clears a stale key from a crashed send.
  const res = await prisma.channelThread.updateMany({
    where: { id: threadId, status: { in: ["PENDING", "ACTIVE"] }, pendingSendKey: null },
    data: { pendingSendKey: key, pendingSendStartedAt: new Date() },
  });
  return res.count > 0 ? key : null;
}

/** Re-read state immediately before a slow provider call. */
async function verifyStillSendable(threadId: string): Promise<boolean> {
  const cur = await prisma.channelThread.findUnique({
    where: { id: threadId },
    select: { status: true, outreach: { select: { job: { select: { appStage: true } } } } },
  });
  if (!cur) return false;
  if (cur.status !== "PENDING" && cur.status !== "ACTIVE") return false;
  // If the owner skipped/closed the job after approving, stop.
  const stage = cur.outreach?.job?.appStage;
  if (stage === "SKIPPED") return false;
  return true;
}

/**
 * Status-guarded send commit. Updates the thread + records the ThreadMessage in
 * one transaction; if the status-guarded update matches 0 rows (a webhook
 * flipped us to REPLIED mid-send), the message left the building but we DON'T
 * advance local state, and we skip the message row.
 */
async function commitSend(
  threadId: string,
  threadData: Record<string, unknown>,
  message: { kind: "INVITE" | "FIRST_DM" | "FOLLOWUP"; body: string; providerMessageId?: string | null },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const res = await tx.channelThread.updateMany({
      where: { id: threadId, status: { in: ["PENDING", "ACTIVE"] } },
      data: { ...threadData, pendingSendKey: null, pendingSendStartedAt: null, consecutiveFailures: 0 },
    });
    if (res.count === 0) {
      console.warn(`[thread ${threadId.slice(-6)}] status changed during send — message left, local state preserved`);
      return false;
    }
    try {
      await tx.threadMessage.create({
        data: {
          threadId,
          direction: "OUTBOUND",
          kind: message.kind,
          body: message.body,
          providerMessageId: message.providerMessageId ?? null,
        },
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "P2002") {
        // Duplicate (threadId, providerMessageId) — provider retried; swallow.
        return true;
      }
      throw err;
    }
    return true;
  });
}

export async function archiveThread(threadId: string, reason: string): Promise<void> {
  await prisma.channelThread.updateMany({
    where: { id: threadId, status: { not: "ARCHIVED" } },
    data: { status: "ARCHIVED", archivedAt: new Date(), archivedReason: reason, nextActionAt: null },
  });
}

/**
 * Mark a thread REPLIED and pause siblings (idempotent):
 *   1. other active threads on the SAME job
 *   2. other active threads for the SAME contact across jobs (one-human rule)
 *
 * Returns true only when THIS call performed the transition (updateMany matched a
 * row). The poll loop and the reply webhook both drive this, so the caller uses
 * the return value to fire the reply-alert / record the inbound message exactly
 * once — a losing racer sees false and stays silent.
 */
export async function markThreadReplied(threadId: string, opts?: { negative?: boolean }): Promise<boolean> {
  const transitioned = await prisma.$transaction(async (tx) => {
    const flip = await tx.channelThread.updateMany({
      where: { id: threadId, status: { in: ["PENDING", "ACTIVE", "PAUSED"] } },
      data: { status: "REPLIED", nextActionAt: null, lastInboundAt: new Date() },
    });
    if (flip.count === 0) return false; // already terminal — someone else won the race

    const outreach = await tx.outreach.findFirst({
      where: { threadId },
      select: { jobId: true, contactId: true },
    });
    if (!outreach) return true;

    // Siblings on the same job + threads for the same contact across jobs.
    const related = await tx.outreach.findMany({
      where: {
        OR: [{ jobId: outreach.jobId }, { contactId: outreach.contactId }],
      },
      select: { threadId: true },
    });
    const toPause = [
      ...new Set(
        related
          .map((o) => o.threadId)
          .filter((id): id is string => !!id && id !== threadId)
      ),
    ];
    if (toPause.length > 0) {
      await tx.channelThread.updateMany({
        where: { id: { in: toPause }, status: { in: ["PENDING", "ACTIVE"] } },
        data: { status: "PAUSED", nextActionAt: null },
      });
    }
    return true;
  });

  if (transitioned && opts?.negative) {
    // Negative reply: fully ARCHIVE so it's a real terminal record, not a
    // success-looking REPLIED with only a hidden archivedReason. status/archivedAt
    // were previously left unset — set them so it stops the sequence AND doesn't
    // inflate the reply/pipeline stats.
    await prisma.channelThread.updateMany({
      where: { id: threadId },
      data: {
        status: "ARCHIVED",
        archivedAt: new Date(),
        archivedReason: "Negative reply — sequence stopped",
        nextActionAt: null,
      },
    });
  }
  return transitioned;
}

// ─── Date helpers ───────────────────────────────────────────────────────────

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}
function minutesFromNow(min: number): Date {
  return new Date(Date.now() + min * 60 * 1000);
}

// ─── Public entry point ─────────────────────────────────────────────────────

export async function processThread(
  threadId: string,
  budget: SendBudgetMut,
  settings?: AppSettingsData,
): Promise<void> {
  const s = settings ?? (await getSettings());
  const thread = await prisma.channelThread.findUnique({
    where: { id: threadId },
    include: { outreach: { include: { job: true, contact: true } } },
  });
  if (!thread) return;
  if (thread.status === "ARCHIVED" || thread.status === "REPLIED" || thread.status === "PAUSED") return;

  const job = thread.outreach?.job;
  if (!job) {
    await archiveThread(threadId, "Orphan thread — no job");
    return;
  }
  if (job.appStage === "SKIPPED") {
    await archiveThread(threadId, `Job ${job.appStage.toLowerCase()} by owner`);
    return;
  }

  if (isCompanyBlacklisted(job.company, s.search.blacklistedCompanies)) {
    const reason = `Company blacklisted: ${job.company}`;
    await archiveThread(threadId, reason);
    await prisma.job.updateMany({ where: { id: job.id, appStage: { not: "SKIPPED" } }, data: { appStage: "SKIPPED", appStageNote: reason, skipSource: "BLACKLIST" } });
    return;
  }

  const accountId = thread.accountId ?? config.owner.linkedinAccountId;
  if (!accountId) {
    await archiveThread(threadId, "No LinkedIn account configured");
    return;
  }

  const ps = (thread.providerState as ProviderState | null) ?? {};
  const phase = ps.phase ?? "QUEUED";
  const providerUserId = thread.candidateProviderId;
  const tag = `[thread ${threadId.slice(-6)} ${thread.outreach?.contact.name ?? "?"} @ ${job.company}]`;

  if (!providerUserId) {
    await archiveThread(threadId, "No LinkedIn provider id on contact");
    return;
  }

  try {
    const contactName = thread.outreach?.contact.name ?? "";
    if (phase === "QUEUED") {
      await doSendInvite(thread, ps, accountId, providerUserId, budget, s, tag);
    } else if (phase === "INVITE_PENDING") {
      await doInvitePendingTimeout(thread, accountId, providerUserId, s, tag);
    } else if (phase === "CONNECTED") {
      // Re-pitch on the company's best-fit OPEN role when this posting has closed.
      const active = await resolveActiveRole(job);
      if (active.redirected) console.log(`${tag} role closed — re-pitching on "${active.role}"`);
      await doSendFirstDm(thread, ps, accountId, providerUserId, budget, s, tag, { contactName, company: job.company, role: active.role, pitch: active.pitch, redirected: active.redirected });
    } else if (phase === "MESSAGED") {
      const active = await resolveActiveRole(job);
      await doFollowup(thread, ps, accountId, budget, s, tag, { contactName, company: job.company, role: active.role, pitch: active.pitch, redirected: active.redirected });
    } else {
      // Unknown phase — nothing to do.
      await guardedThreadUpdate(threadId, { nextActionAt: null });
    }
    await recomputeOutreachState(job.id).catch(() => {});
  } catch (err) {
    // Distress signal? Trip the global pause AND signal the batch loop to abort —
    // returning here would let the loop keep sending to the just-restricted account.
    if (await handleSendError(err)) {
      await clearPendingSend(threadId); // this send failed; don't strand the marker
      await guardedThreadUpdate(threadId, { nextActionAt: minutesFromNow(60) });
      throw new OutreachPausedError();
    }
    // Circuit breaker
    const updated = await prisma.channelThread
      .update({
        where: { id: threadId },
        data: { consecutiveFailures: { increment: 1 } },
        select: { consecutiveFailures: true },
      })
      .catch(() => null);
    if (updated && updated.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      await archiveThread(threadId, `Circuit breaker: ${updated.consecutiveFailures} failures (${String((err as Error).message).slice(0, 160)})`);
      return;
    }
    throw err; // let the tick reschedule a retry
  }
}

// ─── Phase: QUEUED — send the connection invite ──────────────────────────────

type ThreadRow = NonNullable<Awaited<ReturnType<typeof prisma.channelThread.findUnique>>>;

async function doSendInvite(
  thread: ThreadRow,
  ps: ProviderState,
  accountId: string,
  providerUserId: string,
  budget: SendBudgetMut,
  s: AppSettingsData,
  tag: string,
): Promise<void> {
  if (budget.invitesLeft <= 0) {
    await guardedThreadUpdate(thread.id, { nextActionAt: nextSendWindowOpen(s) });
    console.log(`${tag} invite budget exhausted — rescheduled`);
    return;
  }

  if (!(await verifyStillSendable(thread.id))) return;
  if (!(await markPendingSend(thread.id))) return;

  const note = (ps.connectionNote ?? "").slice(0, 300);

  let invitationId = "";
  try {
    const res = await sendInvitation(accountId, providerUserId, note || undefined);
    invitationId = res.invitationId;
  } catch (err) {
    const body = String((err as Error).message ?? "").toLowerCase();
    const code = String((err as { code?: string }).code ?? "").toLowerCase();
    const text = `${body} ${code}`;

    // Already pending → wait for acceptance. Clear the pending-send marker
    // (markPendingSend set it before the call): otherwise reclaimStalePendingSends
    // re-claims this thread in ~10min and doInvitePendingTimeout cancels the still-
    // valid invite long before inviteTimeoutDays.
    if (/cannot_resend_yet|invitation_already|already_invited/.test(text)) {
      await guardedThreadUpdate(thread.id, {
        status: "ACTIVE",
        providerState: { ...ps, phase: "INVITE_PENDING", inviteSentAt: ps.inviteSentAt ?? new Date().toISOString() },
        inviteSentAt: thread.inviteSentAt ?? new Date(),
        nextActionAt: daysFromNow(s.outreach.inviteTimeoutDays),
        pendingSendKey: null,
        pendingSendStartedAt: null,
      });
      console.log(`${tag} invite already pending — waiting`);
      return;
    }
    // Already connected → skip invite, queue first DM for next tick. Clear the
    // pending-send marker so the next-tick claim isn't blocked by the CAS.
    if (/already_connected|already_in_relation|action_already_performed|is_already/.test(text) || (err as { status?: number }).status === 409) {
      await guardedThreadUpdate(thread.id, {
        status: "ACTIVE",
        providerState: { ...ps, phase: "CONNECTED" },
        nextActionAt: new Date(),
        pendingSendKey: null,
        pendingSendStartedAt: null,
      });
      console.log(`${tag} already connected — queued for first DM`);
      return;
    }
    // Permanent: the target can't be invited — an anonymized / out-of-network
    // "LinkedIn Member" whose ephemeral provider_id LinkedIn rejects (invalid
    // parameters, recipient unreachable, 404/422). Retrying 5× changes nothing,
    // so archive NOW instead of burning the circuit breaker and an invite slot.
    if (
      /invalid_parameters|invalid parameters|cannot be reached|cannot_be_reached|unreachable|not_found|does ?n.?t exist|invalid recipient|invalid provider/.test(text) ||
      (err as { status?: number }).status === 422 ||
      (err as { status?: number }).status === 404
    ) {
      await archiveThread(thread.id, `Cannot invite — unreachable/invalid profile (${String((err as Error).message).slice(0, 80)})`);
      console.log(`${tag} invite permanently rejected — archived (${(err as Error).message})`);
      return;
    }
    // Unhandled provider error — the invite did NOT send. Clear the marker so the
    // retry doesn't wait on the stale-pending reclaim sweep.
    await clearPendingSend(thread.id);
    throw err;
  }

  budget.invitesLeft -= 1;
  const ok = await commitSend(
    thread.id,
    {
      status: "ACTIVE",
      providerState: { ...ps, phase: "INVITE_PENDING", inviteSentAt: new Date().toISOString() },
      inviteSentAt: new Date(),
      nextActionAt: daysFromNow(s.outreach.inviteTimeoutDays),
    },
    { kind: "INVITE", body: note, providerMessageId: invitationId || null },
  );
  // Mark the Contact contacted (cooldown gate for other jobs).
  if (ok) {
    await prisma.contact
      .updateMany({ where: { linkedinProviderId: providerUserId }, data: { lastContactedAt: new Date() } })
      .catch(() => {});
    console.log(`${tag} invite sent`);
  }
}

// ─── Phase: INVITE_PENDING — timeout reached, re-check for silent accept ──────

async function doInvitePendingTimeout(
  thread: ThreadRow,
  accountId: string,
  providerUserId: string,
  s: AppSettingsData,
  tag: string,
): Promise<void> {
  const ps = (thread.providerState as ProviderState | null) ?? {};

  // Re-fetch the profile to catch a silent acceptance (an accepted invite whose
  // new_relation webhook we missed) before giving up on this invite.
  let profile: Awaited<ReturnType<typeof fetchProfile>> | null = null;
  try {
    profile = await fetchProfile(accountId, providerUserId);
  } catch (err) {
    // TRANSIENT fetch failure (network / rate-limit) is NOT a "not connected"
    // answer. Falling through to cancel+archive here would discard an invite the
    // contact may ALREADY have accepted — the acceptance would be lost forever.
    // So bump the failure counter and reschedule a short retry; the next tick
    // re-checks. Only give up once we hit the same cap the circuit breaker uses,
    // so a durably-unreachable profile can't loop forever.
    const updated = await prisma.channelThread
      .update({
        where: { id: thread.id },
        data: { consecutiveFailures: { increment: 1 } },
        select: { consecutiveFailures: true },
      })
      .catch(() => null);
    if (!updated || updated.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      // minutesFromNow(60): same modest backoff the distress path uses.
      await guardedThreadUpdate(thread.id, { nextActionAt: minutesFromNow(60) });
      console.warn(`${tag} profile re-fetch failed at timeout check (retry ${updated?.consecutiveFailures ?? "?"}/${MAX_CONSECUTIVE_FAILURES}):`, (err as Error).message);
      return;
    }
    // Cap reached — treat the profile as durably unreachable and fall through to
    // cancel+archive (profile stays null → isAlreadyConnected() is false).
    console.warn(`${tag} profile re-fetch failed ${MAX_CONSECUTIVE_FAILURES}× — giving up:`, (err as Error).message);
  }

  // Fetch SUCCEEDED (or exhausted retries): trust the real connection state.
  if (isAlreadyConnected(profile)) {
    await guardedThreadUpdate(thread.id, {
      status: "ACTIVE",
      providerState: { ...ps, phase: "CONNECTED" },
      nextActionAt: new Date(),
      consecutiveFailures: 0,
    });
    console.log(`${tag} silent acceptance detected → CONNECTED`);
    return;
  }
  // Confirmed not connected — cancel the pending invite, then archive.
  try {
    const sent = await listSentInvitations(accountId);
    const match = sent?.find((i) => i.invitedUserId === providerUserId || i.invitedUserPublicId === providerUserId);
    if (match) await cancelInvitation(accountId, match.id);
  } catch {
    /* best effort */
  }
  await archiveThread(thread.id, "Invite acceptance timeout");
  console.log(`${tag} invite timed out — archived`);
}

// ─── Phase: CONNECTED — send the first DM ────────────────────────────────────

async function doSendFirstDm(
  thread: ThreadRow,
  ps: ProviderState,
  accountId: string,
  providerUserId: string,
  budget: SendBudgetMut,
  s: AppSettingsData,
  tag: string,
  ctx: { contactName: string; company: string; role: string; pitch?: string | null; redirected?: boolean },
): Promise<void> {
  if (thread.lastMessageAt) {
    // DM already sent (we somehow re-entered) — move to MESSAGED. Also push
    // nextActionAt to the follow-up cadence: the claim left it at now+15min
    // (retry marker), which would re-claim this thread and fire a follow-up early.
    await guardedThreadUpdate(thread.id, {
      providerState: { ...ps, phase: "MESSAGED" },
      nextActionAt: daysFromNow(s.outreach.followupAfterDays),
    });
    return;
  }
  if (budget.dmsLeft <= 0) {
    await guardedThreadUpdate(thread.id, { nextActionAt: nextSendWindowOpen(s) });
    console.log(`${tag} DM budget exhausted — rescheduled`);
    return;
  }
  if (!(await verifyStillSendable(thread.id))) return;
  if (!(await markPendingSend(thread.id))) return;

  const rendered = await renderMessages({ name: ctx.contactName, company: ctx.company, role: ctx.role, pitch: ctx.pitch });
  // Prefer the per-thread draft (set at enqueue time, editable in the confirm
  // drawer). Fall back to the live template so global template edits still
  // propagate to auto-queued threads that were never individually reviewed.
  // EXCEPTION: when the posting closed and we're re-pitching on a different open
  // role, the stored draft names the wrong (closed) role — re-render instead.
  const text = (!ctx.redirected && ps.firstDm?.trim()) || rendered.firstDm;

  const resumeKey =
    (await prisma.channelThread.findUnique({
      where: { id: thread.id },
      select: { outreach: { select: { job: { select: { tailoredResumeKey: true } } } } },
    }))?.outreach?.job?.tailoredResumeKey ??
    (await prisma.resumeProfile.findUnique({ where: { id: "default" } }))?.baseResumeKey ??
    null;
  let attachment: MessageAttachment | undefined;
  if (resumeKey) {
    try {
      const data = await downloadResume(resumeKey);
      attachment = { data, filename: resumeKey.split("/").pop() ?? "resume.pdf" };
    } catch (err) {
      // A referral first-DM MUST carry the resume — do NOT fall through and send
      // it PDF-less (that's the bug where contacts got a pitch with no attachment
      // whenever an S3 read blipped). Defer and retry the whole send later; the
      // download already retried internally, so this is a durable-ish failure.
      // Clear the pending-send marker (set by markPendingSend) so the retry isn't
      // blocked by the CAS. Not a per-contact fault → don't burn the circuit breaker.
      console.error(`${tag} resume download failed — deferring send (won't pitch without the resume):`, err);
      await guardedThreadUpdate(thread.id, {
        nextActionAt: minutesFromNow(30),
        pendingSendKey: null,
        pendingSendStartedAt: null,
      });
      return;
    }
  }

  let chatId = "";
  let messageId = "";
  try {
    ({ chatId, messageId } = await startChat(accountId, providerUserId, text, attachment));
  } catch (err) {
    const body = String((err as Error).message ?? "").toLowerCase();
    const code = String((err as { code?: string }).code ?? "").toLowerCase();
    const text = `${body} ${code}`;
    // "Subscription required" / "Recipient cannot be reached" / no-connection all
    // mean the same thing: we are NOT a 1st-degree connection, so the acceptance
    // signal that moved us to CONNECTED was wrong (a missed/early webhook or a
    // stale flip). Don't burn the circuit breaker and archive a contact whose
    // invite may still be pending — revert to INVITE_PENDING and wait for the
    // real new_relation webhook. The 7-day timeout still cleans up dead invites.
    if (
      /no_connection_with_recipient|subscription required|subscription_required|cannot be reached|cannot_be_reached|not_connected|no connection/.test(
        text,
      )
    ) {
      await guardedThreadUpdate(thread.id, {
        status: "ACTIVE",
        providerState: { ...ps, phase: "INVITE_PENDING" },
        consecutiveFailures: 0,
        pendingSendKey: null,
        pendingSendStartedAt: null,
        nextActionAt: daysFromNow(s.outreach.inviteTimeoutDays),
      });
      console.log(`${tag} DM blocked (not connected: "${body.slice(0, 60)}") — back to INVITE_PENDING, awaiting acceptance`);
      return;
    }
    // Unhandled provider error — the DM did NOT send. Clear the marker so the
    // retry doesn't wait on the stale-pending reclaim sweep.
    await clearPendingSend(thread.id);
    throw err;
  }

  budget.dmsLeft -= 1;
  const hasFollowup = 1 < thread.followupsTotal;
  const ok = await commitSend(
    thread.id,
    {
      providerState: { ...ps, phase: "MESSAGED" },
      providerChatId: chatId,
      lastMessageAt: new Date(),
      followupsSent: 1,
      nextActionAt: hasFollowup ? daysFromNow(s.outreach.followupAfterDays) : null,
    },
    { kind: "FIRST_DM", body: text, providerMessageId: messageId || null },
  );
  if (ok) console.log(`${tag} first DM sent (chatId=${chatId})`);
}

// ─── Phase: MESSAGED — send a follow-up (or archive when exhausted) ───────────

async function doFollowup(
  thread: ThreadRow,
  ps: ProviderState,
  accountId: string,
  budget: SendBudgetMut,
  s: AppSettingsData,
  tag: string,
  ctx: { contactName: string; company: string; role: string; pitch?: string | null; redirected?: boolean },
): Promise<void> {
  if (thread.followupsSent >= thread.followupsTotal) {
    await archiveThread(thread.id, "All follow-ups exhausted — no reply");
    return;
  }
  if (!thread.providerChatId) {
    await archiveThread(thread.id, "Missing chat id for follow-up");
    return;
  }
  if (budget.dmsLeft <= 0) {
    await guardedThreadUpdate(thread.id, { nextActionAt: nextSendWindowOpen(s) });
    return;
  }
  if (!(await verifyStillSendable(thread.id))) return;
  if (!(await markPendingSend(thread.id))) return;

  const rendered = await renderMessages({ name: ctx.contactName, company: ctx.company, role: ctx.role, pitch: ctx.pitch });
  // A redirected (closed→open) thread's stored follow-up names the closed role —
  // re-render so the nudge mentions the now-active open role.
  const text = (!ctx.redirected && ps.followup?.trim()) || rendered.followup;
  let messageId = "";
  try {
    ({ messageId } = await sendChatMessage(accountId, thread.providerChatId, text));
  } catch (err) {
    // Follow-up did NOT send — clear the marker so the retry isn't stalled ~10min.
    await clearPendingSend(thread.id);
    throw err;
  }

  budget.dmsLeft -= 1;
  const newSent = thread.followupsSent + 1;
  const hasMore = newSent < thread.followupsTotal;
  const ok = await commitSend(
    thread.id,
    {
      lastMessageAt: new Date(),
      followupsSent: newSent,
      nextActionAt: hasMore ? daysFromNow(s.outreach.followupAfterDays) : null,
    },
    { kind: "FOLLOWUP", body: text, providerMessageId: messageId || null },
  );
  if (ok) {
    console.log(`${tag} follow-up ${newSent - 1}/${thread.followupsTotal - 1} sent`);
    if (!hasMore) await archiveThread(thread.id, "All follow-ups exhausted — no reply");
  }
}
