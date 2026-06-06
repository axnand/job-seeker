/**
 * POST /api/cron/tick
 * Triggered by Vercel Cron every 30 min between 03:30–16:00 UTC (09:00–21:30 IST),
 * and/or by an external cron (cron-job.org / GitHub Actions) on the free tier.
 * Protected by Bearer CRON_SECRET (enforced in middleware.ts).
 *
 * Advances the outreach engine: poll invite acceptances + replies (missed-webhook
 * fallback), then claim due ChannelThreads and run the state machine within the
 * send window + rate budget.
 */

import { NextResponse } from "next/server";
import { runOutreachTick } from "@/outreach/outreach-tick";
import { withCronLock } from "@/lib/cron-lock";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  try {
    // Skip if a previous tick is still running (its poll fallbacks aren't
    // claim-safe to run concurrently).
    const locked = await withCronLock("tick", () => runOutreachTick());
    if (!locked.ran) {
      return NextResponse.json({ ok: true, skipped: "already running" });
    }
    return NextResponse.json({ ok: true, ...locked.result });
  } catch (err) {
    console.error("[cron/tick] fatal:", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

// cron-job.org / browsers can hit GET; same Bearer auth (middleware).
export async function GET() { return POST(); }
