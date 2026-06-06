/**
 * Derive Job.outreachState (machine-owned cache) from the job's ChannelThreads.
 * This is the job-domain equivalent of Hirro's recomputeTaskStage — it never
 * touches appStage (human-owned), so the two axes can't clobber each other.
 *
 * Priority (highest wins): REPLIED > MESSAGED > CONNECTED > INVITE_SENT >
 * NO_REPLY_ARCHIVED > NONE.
 */

import { prisma } from "@/lib/prisma";
import type { OutreachState } from "@prisma/client";

const RANK: Record<OutreachState, number> = {
  REPLIED: 5,
  MESSAGED: 4,
  CONNECTED: 3,
  INVITE_SENT: 2,
  NO_REPLY_ARCHIVED: 1,
  NONE: 0,
};

function threadToState(status: string, phase: string | undefined): OutreachState {
  if (status === "REPLIED") return "REPLIED";
  if (status === "ARCHIVED") return "NO_REPLY_ARCHIVED";
  // PENDING / ACTIVE / PAUSED → look at the provider phase
  switch (phase) {
    case "MESSAGED":
      return "MESSAGED";
    case "CONNECTED":
      return "CONNECTED";
    case "INVITE_PENDING":
      return "INVITE_SENT";
    default:
      return "NONE"; // DRAFT / QUEUED / none — nothing has been sent yet
  }
}

export async function recomputeOutreachState(jobId: string): Promise<OutreachState> {
  const outreaches = await prisma.outreach.findMany({
    where: { jobId },
    select: { threadId: true },
  });
  const threadIds = outreaches.map((o) => o.threadId).filter((id): id is string => !!id);

  let best: OutreachState = "NONE";
  if (threadIds.length > 0) {
    const threads = await prisma.channelThread.findMany({
      where: { id: { in: threadIds } },
      select: { status: true, providerState: true },
    });
    for (const t of threads) {
      const phase = (t.providerState as { phase?: string } | null)?.phase;
      const st = threadToState(t.status, phase);
      if (RANK[st] > RANK[best]) best = st;
    }
  }

  // Advance the human-facing appStage to mirror outreach progress
  // (New → Approved → Outreach → Replied). Never downgrade; never touch SKIPPED.
  const APP_RANK: Record<string, number> = { NEW: 0, APPROVED: 1, OUTREACH: 2, REPLIED: 3, SKIPPED: -1 };
  const targetStage =
    best === "REPLIED" ? "REPLIED"
    : best === "MESSAGED" || best === "CONNECTED" || best === "INVITE_SENT" || best === "NO_REPLY_ARCHIVED" ? "OUTREACH"
    : "APPROVED"; // outreach rows exist but nothing sent yet

  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { appStage: true } });
  const cur = job?.appStage ?? "NEW";
  const data: { outreachState: OutreachState; appStage?: "APPROVED" | "OUTREACH" | "REPLIED" } = { outreachState: best };
  if (cur !== "SKIPPED" && APP_RANK[targetStage] > (APP_RANK[cur] ?? 0)) {
    data.appStage = targetStage as "APPROVED" | "OUTREACH" | "REPLIED";
  }
  await prisma.job.update({ where: { id: jobId }, data });
  return best;
}

/** Find the jobId that owns a given thread (for webhook/poll → recompute). */
export async function jobIdForThread(threadId: string): Promise<string | null> {
  const outreach = await prisma.outreach.findFirst({
    where: { threadId },
    select: { jobId: true },
  });
  return outreach?.jobId ?? null;
}
