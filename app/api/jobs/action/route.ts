/**
 * POST /api/jobs/action
 * Body: { jobId, action: "approve" | "skip" | "applied" | "interviewing" | "offer" | "closed", note? }
 * Updates appStage. On approve, outreach queuing happens in Phase 2.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { AppStage } from "@prisma/client";

const VALID_ACTIONS: AppStage[] = [
  "APPROVED", "SKIPPED", "APPLIED", "INTERVIEWING", "OFFER", "CLOSED",
];

export async function POST(req: NextRequest) {
  const body = await req.json() as { jobId?: string; action?: string; note?: string };

  if (!body.jobId || !body.action) {
    return NextResponse.json({ error: "jobId and action required" }, { status: 400 });
  }

  const newStage = body.action.toUpperCase() as AppStage;
  if (!VALID_ACTIONS.includes(newStage)) {
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }

  const job = await prisma.job.update({
    where: { id: body.jobId },
    data: {
      appStage: newStage,
      appStageNote: body.note ?? null,
      ...(newStage === "APPROVED" ? { approvedAt: new Date() } : {}),
      ...(newStage === "APPLIED" ? { appliedAt: new Date() } : {}),
    },
  });

  // Phase 2: if newStage === "APPROVED", queue outreach (people finder → message writer → thread)

  return NextResponse.json({ ok: true, job });
}
