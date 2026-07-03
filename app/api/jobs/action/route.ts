/**
 * POST /api/jobs/action
 * Body: { jobId, action: "approve" | "skip" | "applied" | "interviewing" | "offer" | "closed", note? }
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
  "NEW", "APPROVED", "OUTREACH", "REPLIED", "SKIPPED",
];

// Friendly verbs used by the UI → canonical stage.
const ACTION_ALIASES: Record<string, AppStage> = {
  approve:  "APPROVED",
  skip:     "SKIPPED",
  replied:  "REPLIED",
  outreach: "OUTREACH",
  restore:  "NEW",
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

  const isRestore = body.action?.toLowerCase() === "restore";
  let job;
  try {
    job = await prisma.job.update({
      where: { id: body.jobId },
      data: {
        appStage: newStage,
        // Restore wipes the skip-reason; explicit note overrides both directions.
        appStageNote: body.note ?? (isRestore ? null : undefined),
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
  // MANUAL_NOTIFY jobs, or draft referral outreach (people finder → message
  // writer → DRAFT threads the owner confirms before anything sends).
  let enqueue = null;
  if (newStage === "APPROVED") {
    try {
      enqueue = await enqueueOutreach(job);
    } catch (err) {
      console.error(`[jobs/action] enqueueOutreach failed for ${job.id}:`, err);
    }
  }

  return NextResponse.json({ ok: true, job, enqueue });
}
