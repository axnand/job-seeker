/**
 * POST /api/jobs/tailor
 * Body: { jobId: string; force?: boolean }
 *
 * Manually (re)run automated resume tailoring for one job. With force=true the
 * previous attempt is discarded (tailorLog cleared, tailoredResumeKey unset) so
 * the pipeline runs fresh — used by the "Regenerate" action in the UI.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { tailorResumeForJob } from "@/resume/pipeline";

export const maxDuration = 300; // LLM proposal + external compile + repairs

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { jobId?: string; force?: boolean } | null;
  if (!body?.jobId) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }

  if (body.force) {
    await prisma.job.update({
      where: { id: body.jobId },
      data: { tailoredResumeKey: null, tailorLog: Prisma.DbNull },
    }).catch(() => {});
  }

  const outcome = await tailorResumeForJob(body.jobId);
  const job = await prisma.job.findUnique({
    where: { id: body.jobId },
    select: { tailoredResumeKey: true, tailorLog: true },
  });

  return NextResponse.json({ ok: outcome.status === "tailored", outcome, ...job });
}
