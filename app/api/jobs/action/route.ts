/**
 * POST /api/jobs/action
 * Body: { jobId, action: "approve" | "skip" | "replied" | "outreach" | "restore" | "applied" | "interviewing" | "offer", note? }
 * Updates appStage. On approve, outreach queuing happens in Phase 2.
 */

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueueOutreach } from "@/outreach/enqueue";
import type { AppStage } from "@prisma/client";

// Approve runs people-search + AI message drafting inline — give it room.
export const maxDuration = 60;

const VALID_ACTIONS: AppStage[] = [
  // "NEW" is the target of the "restore" alias (un-skip a job back onto the board).
  "NEW", "APPROVED", "OUTREACH", "REPLIED", "APPLIED", "INTERVIEWING", "OFFER", "SKIPPED",
];

// Friendly verbs used by the UI → canonical stage.
const ACTION_ALIASES: Record<string, AppStage> = {
  approve:      "APPROVED",
  skip:         "SKIPPED",
  replied:      "REPLIED",
  outreach:     "OUTREACH",
  restore:      "NEW",
  applied:      "APPLIED",
  interviewing: "INTERVIEWING",
  offer:        "OFFER",
};

export async function POST(req: NextRequest) {
  const body = await req.json() as { jobId?: string; action?: string; note?: string };

  if (!body.jobId || !body.action) {
    return NextResponse.json({ error: "jobId and action required" }, { status: 400 });
  }

  const key = body.action.toLowerCase();
  const newStage = (ACTION_ALIASES[key] ?? body.action.toUpperCase()) as AppStage;
  if (!VALID_ACTIONS.includes(newStage)) {
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }

  const isRestore = key === "restore";

  // Read the current stage BEFORE writing so we can guard foot-gun transitions
  // that the unconditional "any stage → any stage" update used to wave through.
  const current = await prisma.job.findUnique({
    where: { id: body.jobId },
    select: { appStage: true },
  });
  if (!current) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }

  // "restore" only makes sense for a skipped job — it clears the skip reason and
  // drops the job back to NEW. Run on a live job it would silently demote it and
  // wipe its note, so reject rather than fire the foot-gun. (The UI only ever
  // restores from the Skipped list, so no legitimate caller hits this.)
  if (isRestore && current.appStage !== "SKIPPED") {
    return NextResponse.json(
      { error: "restore only applies to skipped jobs", currentStage: current.appStage },
      { status: 400 },
    );
  }

  // No-op: already in the requested stage. Don't rewrite (which would reset
  // approvedAt / re-run enqueue) — report it so the UI can distinguish it from a
  // real move instead of showing a silent success.
  if (current.appStage === newStage) {
    return NextResponse.json({ ok: true, noop: true, note: `already ${newStage}`, currentStage: newStage });
  }

  let job;
  try {
    job = await prisma.job.update({
      where: { id: body.jobId },
      data: {
        appStage: newStage,
        // Restore wipes the skip-reason; explicit note overrides both directions.
        appStageNote: body.note ?? (isRestore ? null : undefined),
        // A skip via the UI is always owner-driven → MANUAL. Any move OFF skipped
        // clears provenance so the field only ever describes a currently-skipped job.
        skipSource: newStage === "SKIPPED" ? "MANUAL" : null,
        ...(newStage === "APPROVED" ? { approvedAt: new Date() } : {}),
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "job not found" }, { status: 404 });
    }
    throw err;
  }

  // On approve, kick off the outreach machine: manual-notify email for
  // MANUAL_NOTIFY jobs, or referral outreach (people finder → message writer →
  // QUEUED/CONNECTED threads that auto-send on the next tick, gated by the send
  // window + rate budget + globalPause).
  let enqueue = null;
  let alreadyQueued = false;
  if (newStage === "APPROVED") {
    try {
      enqueue = await enqueueOutreach(job);
      // enqueueOutreach is idempotent: a "noop" with existing rows means this
      // job already had outreach (e.g. approved once, skipped, restored, then
      // re-approved). Surface it so the UI can say "already queued" rather than
      // implying fresh drafts were created.
      alreadyQueued = enqueue.mode === "noop" && enqueue.targetsDrafted > 0;
    } catch (err) {
      console.error(`[jobs/action] enqueueOutreach failed for ${job.id}:`, err);
    }
  }

  return NextResponse.json({ ok: true, job, enqueue, alreadyQueued });
}
