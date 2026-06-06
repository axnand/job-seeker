/**
 * POST /api/outreach/confirm
 * Body: { threadId, action: "send" | "cancel", connectionNote?, firstDm?, followup? }
 *
 * The "never blind-send" gate. A DRAFT thread sits with nextActionAt=null so the
 * tick never claims it. The owner reviews/edits the messages here and either:
 *   • send   → save edits, phase=QUEUED, nextActionAt=now (next tick sends the invite)
 *   • cancel → archive the draft (no send)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { recomputeOutreachState } from "@/status/outreach-state";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    threadId?: string;
    action?: "send" | "cancel";
    connectionNote?: string;
    firstDm?: string;
    followup?: string;
  };

  if (!body.threadId || !body.action) {
    return NextResponse.json({ error: "threadId and action required" }, { status: 400 });
  }

  const thread = await prisma.channelThread.findUnique({
    where: { id: body.threadId },
    select: { id: true, status: true, providerState: true, outreachId: true },
  });
  if (!thread) return NextResponse.json({ error: "thread not found" }, { status: 404 });

  const ps = (thread.providerState as Record<string, unknown> | null) ?? {};
  const phase = ps.phase as string | undefined;

  // Only DRAFT threads are confirmable. (Idempotent: re-confirming a QUEUED one
  // is harmless but we guard so we don't reset an in-flight sequence.)
  if (phase !== "DRAFT") {
    return NextResponse.json({ error: `thread is not a draft (phase=${phase})`, ok: false }, { status: 409 });
  }

  const outreach = thread.outreachId
    ? await prisma.outreach.findUnique({ where: { id: thread.outreachId }, select: { jobId: true } })
    : null;

  if (body.action === "cancel") {
    await prisma.channelThread.update({
      where: { id: thread.id },
      data: { status: "ARCHIVED", archivedAt: new Date(), archivedReason: "Cancelled by owner", nextActionAt: null },
    });
    if (outreach?.jobId) await recomputeOutreachState(outreach.jobId).catch(() => {});
    return NextResponse.json({ ok: true, cancelled: true });
  }

  // send
  await prisma.channelThread.update({
    where: { id: thread.id },
    data: {
      status: "PENDING",
      nextActionAt: new Date(),
      providerState: {
        ...ps,
        phase: "QUEUED",
        connectionNote: (body.connectionNote ?? (ps.connectionNote as string) ?? "").slice(0, 300),
        firstDm: body.firstDm ?? (ps.firstDm as string) ?? "",
        followup: body.followup ?? (ps.followup as string) ?? "",
      },
    },
  });
  if (outreach?.jobId) await recomputeOutreachState(outreach.jobId).catch(() => {});
  return NextResponse.json({ ok: true, queued: true });
}
