/**
 * POST /api/outreach/send  { jobIds: string[] }
 * Manual bulk "Send requests" — fires the queued outreach for the selected jobs
 * now (bypasses the send window; respects globalPause + rate caps).
 * Behind basic auth (middleware). Used by the board's bulk-select action bar.
 */

import { NextRequest, NextResponse } from "next/server";
import { sendForJobs, clearQueuedForJobs } from "@/outreach/outreach-tick";
import { withCronLock } from "@/lib/cron-lock";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { jobIds?: string[]; withNote?: boolean; clearQueue?: boolean; only?: "invite" | "dm" };
  const jobIds = Array.isArray(body.jobIds) ? body.jobIds.filter(Boolean) : [];
  if (jobIds.length === 0) {
    return NextResponse.json({ error: "jobIds required" }, { status: 400 });
  }
  const only = body.only === "invite" || body.only === "dm" ? body.only : undefined;
  // Manual sends bypass the daily invite cap — user explicitly chose these jobs.
  // Take the same "tick" lock the cron holds so a manual send and a cron tick
  // can't drive the same threads concurrently (double-claim / double-send).
  const locked = await withCronLock("tick", async () => {
    const result = await sendForJobs(jobIds, { withNote: body.withNote === true, ignoreInviteLimit: true, ignoreDmLimit: true, only });

    // Fast-track: once the owner has sent, drop anything still queued for these
    // jobs so the tick won't send more behind their back ("the task is done now").
    // Skip the fast-track clear on a scoped send (only=invite/dm) — the other
    // kind still needs to go out later.
    let cleared = 0;
    if (body.clearQueue === true && !only) {
      cleared = await clearQueuedForJobs(jobIds).catch(() => 0);
    }
    return { ...result, cleared };
  });

  if (!locked.ran) {
    return NextResponse.json(
      { ok: false, error: "A tick is already running — try again in a moment." },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, ...locked.result });
}
