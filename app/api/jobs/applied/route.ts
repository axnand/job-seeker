/**
 * POST /api/jobs/applied
 * Body: { jobId: string; applied: boolean }
 *
 * Dual-application tracking: marks that the owner applied DIRECTLY (alternate
 * identity), independent of the referral pipeline. Toggling off clears it.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { jobId?: string; applied?: boolean } | null;
  if (!body?.jobId || typeof body.applied !== "boolean") {
    return NextResponse.json({ error: "jobId and applied (boolean) required" }, { status: 400 });
  }

  try {
    const job = await prisma.job.update({
      where: { id: body.jobId },
      data: { directAppliedAt: body.applied ? new Date() : null },
      select: { id: true, directAppliedAt: true },
    });
    return NextResponse.json({ ok: true, ...job });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "job not found" }, { status: 404 });
    }
    throw err;
  }
}
