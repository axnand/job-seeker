/**
 * POST /api/jobs/close
 * Body: { jobId: string; closed: boolean; reason?: string }
 *
 * Closes (or reopens) a SINGLE posting. This is deliberately NOT a blacklist and
 * NOT a skip:
 *   • the company stays open — its other roles and the shared contact pool are
 *     untouched;
 *   • the posting stays on the board (inside its company card, toggled off);
 *   • no fresh invites are queued for a closed role (the replenish loop skips it);
 *   • in-flight threads are NOT killed — at send time they get re-pitched on the
 *     company's best-fit OPEN role (see resolveActiveRole), so people already
 *     contacted under a role that just closed get redirected to the open one
 *     instead of being stranded.
 *
 * Reopen simply clears closedAt; the replenish loop will top the role back up.
 */

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { jobId?: string; closed?: boolean; reason?: string };
  if (!body.jobId || typeof body.closed !== "boolean") {
    return NextResponse.json({ error: "jobId and closed (boolean) required" }, { status: 400 });
  }

  let job;
  try {
    job = await prisma.job.update({
      where: { id: body.jobId },
      data: body.closed
        ? { closedAt: new Date(), closedReason: body.reason ?? "Role closed by owner" }
        : { closedAt: null, closedReason: null },
      select: { id: true, company: true, role: true, closedAt: true, closedReason: true, appStage: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "job not found" }, { status: 404 });
    }
    throw err;
  }

  return NextResponse.json({ ok: true, job });
}
