/**
 * POST /api/jobs/action
 * Body: { jobId, action: "approve" | "skip" | "applied" | "interviewing" | "offer" | "closed", note? }
 * Updates appStage. On approve, outreach queuing happens in Phase 2.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueOutreach } from "@/outreach/enqueue";
import type { AppStage } from "@prisma/client";

// Approve runs people-search + AI message drafting inline — give it room.
export const maxDuration = 60;

const VALID_ACTIONS: AppStage[] = [
  "APPROVED", "OUTREACH", "REPLIED", "SKIPPED",
];

// Friendly verbs used by the UI → canonical stage.
const ACTION_ALIASES: Record<string, AppStage> = {
  approve: "APPROVED",
  skip: "SKIPPED",
  replied: "REPLIED",
  outreach: "OUTREACH",
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

  const job = await prisma.job.update({
    where: { id: body.jobId },
    data: {
      appStage: newStage,
      appStageNote: body.note ?? null,
      ...(newStage === "APPROVED" ? { approvedAt: new Date() } : {}),
      
    },
  });

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
