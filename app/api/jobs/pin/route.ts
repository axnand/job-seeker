/**
 * POST /api/jobs/pin
 * Body: { jobId: string; pinned: boolean }
 *
 * Owner's manual ⭐. Pinned jobs sort first on the board and always appear in
 * the Apply Today shortlist, regardless of computed priority.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { jobId?: string; pinned?: boolean };
  if (!body.jobId || typeof body.pinned !== "boolean") {
    return NextResponse.json({ error: "jobId and pinned (boolean) required" }, { status: 400 });
  }

  const job = await prisma.job.update({
    where: { id: body.jobId },
    data: { pinned: body.pinned },
    select: { id: true, pinned: true },
  });

  return NextResponse.json({ ok: true, job });
}
