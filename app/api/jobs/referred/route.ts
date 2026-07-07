/**
 * POST /api/jobs/referred
 * Body: { jobId: string; referred: boolean }
 *
 * Marks that a referral actually LANDED for this job (someone agreed to refer /
 * submitted the owner) — the success outcome of the outreach track, distinct
 * from REPLIED. Independent of appStage and directAppliedAt; toggling off clears it.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { jobId?: string; referred?: boolean } | null;
  if (!body?.jobId || typeof body.referred !== "boolean") {
    return NextResponse.json({ error: "jobId and referred (boolean) required" }, { status: 400 });
  }

  try {
    const job = await prisma.job.update({
      where: { id: body.jobId },
      data: { referredAt: body.referred ? new Date() : null },
      select: { id: true, referredAt: true },
    });
    return NextResponse.json({ ok: true, ...job });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "job not found" }, { status: 404 });
    }
    throw err;
  }
}
