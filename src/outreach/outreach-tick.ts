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
import { isNegativeReply } from "./classify-reply";
import { recomputeOutreachState } from "@/status/outreach-state";
import {
  listSentInvitations,
  listChatMessages,
  type SentInvitation,
} from "@/unipile/client";
import { sendReplyAlert } from "@/email/digest";

const MAX_PER_TICK = 50;
const RETRY_DELAY_MS = 5 * 60 * 1000;

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
}

export async function runOutreachTick(): Promise<TickResult> {
  const settings = await getSettings();
  const base: TickResult = {
    processed: 0, failed: 0, claimed: 0, pollAccepted: 0, pollReplied: 0, staleArchived: 0,
  };

  // Poll fallbacks first — read-only-ish, safe regardless of pause/window, and
  // they recover from missed webhooks (advance acceptances/replies).
  base.pollAccepted = await pollInviteAcceptances().catch((e) => {
    console.error("[tick] pollInviteAcceptances failed:", e);
    return 0;
  });
  base.pollReplied = await pollReplies().catch((e) => {
    console.error("[tick] pollReplies failed:", e);
    return 0;
  });
  base.staleArchived = await sweepStaleDrafts(config.staleness.archiveAfterDays).catch(() => 0);

  if (settings.outreach.globalPause) {
    return { ...base, paused: true };
  }
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

// ─── Claim ────────────────────────────────────────────────────────────────────

async function claimDueThreads(limit: number): Promise<string[]> {
  const now = new Date();
  try {
    const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      WITH claimed AS (
        UPDATE "ChannelThread"
        SET "nextActionAt" = NULL
        WHERE id IN (
          SELECT id FROM "ChannelThread"
          WHERE status IN ('PENDING', 'ACTIVE')
            AND "nextActionAt" IS NOT NULL
            AND "nextActionAt" <= ${now}
          ORDER BY "nextActionAt" ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
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

// ─── Poll fallback: invite acceptances ──────────────────────────────────────

async function pollInviteAcceptances(): Promise<number> {
  const accountId = config.owner.linkedinAccountId;
  if (!accountId) return 0;

  const pending = await prisma.channelThread.findMany({
    where: {
      status: "ACTIVE",
      providerState: { path: ["phase"], equals: "INVITE_PENDING" },
    },
    select: { id: true, candidateProviderId: true, providerState: true, outreachId: true },
  });
  if (pending.length === 0) return 0;

  let sent: SentInvitation[];
  try {
    sent = await listSentInvitations(accountId, 200);
  } catch {
    return 0;
  }
  const stillPending = new Set(
    sent.flatMap((i) => [i.invitedUserId, i.invitedUserPublicId].filter((x): x is string => !!x))
  );

  let accepted = 0;
  for (const t of pending) {
    if (!t.candidateProviderId) continue;
    if (stillPending.has(t.candidateProviderId)) continue; // still awaiting

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
  if (accepted > 0) console.log(`[tick] pollInviteAcceptances: ${accepted} accepted → CONNECTED`);
  return accepted;
}

// ─── Poll fallback: replies ─────────────────────────────────────────────────

async function pollReplies(): Promise<number> {
  const accountId = config.owner.linkedinAccountId;
  if (!accountId) return 0;

  const active = await prisma.channelThread.findMany({
    where: { status: "ACTIVE", providerChatId: { not: null }, lastMessageAt: { not: null } },
    select: {
      id: true,
      providerChatId: true,
      lastMessageAt: true,
      outreach: { include: { job: true, contact: true } },
    },
  });
  if (active.length === 0) return 0;

  let replied = 0;
  for (const t of active) {
    if (!t.providerChatId || !t.lastMessageAt) continue;
    const messages = await listChatMessages(accountId, t.providerChatId, 5);
    const inbound = messages.find((m) => !m.fromMe && m.date && new Date(m.date) > t.lastMessageAt!);
    if (!inbound) continue;

    await handleInboundReply(t.id, inbound.text, t.outreach);
    replied++;
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
  await markThreadReplied(threadId, { negative });

  if (outreach?.job) {
    await recomputeOutreachState(outreach.job.id).catch(() => {});
    // Record the inbound message for history.
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
