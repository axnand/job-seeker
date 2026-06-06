/**
 * POST /api/cron/tick
 * Triggered by Vercel Cron every 30 min between 03:30–16:00 UTC (09:00–21:30 IST).
 * Advances ChannelThread outreach sequences: poll invite acceptances, send DMs, follow-ups.
 * Full outreach engine lives in Phase 2 (src/outreach/). This stub returns a no-op
 * until that phase is built, so the cron endpoint exists and is reachable.
 */

import { NextResponse } from "next/server";

export async function POST() {
  // Phase 2: import and call runOutreachTick() here
  return NextResponse.json({ ok: true, message: "tick — outreach engine pending Phase 2" });
}
