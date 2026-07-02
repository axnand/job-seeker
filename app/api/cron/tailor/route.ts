/**
 * POST /api/cron/tailor
 * Catch-up sweep for automated resume tailoring: picks up APPROVED jobs with
 * needsTailoring=true that don't yet have a tailored PDF (e.g. discover's
 * inline pass ran out of time, or a run died mid-way).
 * Wire to cron-job.org at a relaxed cadence (e.g. hourly) — discover already
 * tailors its own jobs inline, so this is resilience, not the primary path.
 * Protected by Bearer CRON_SECRET (enforced in middleware.ts).
 */

import { NextResponse } from "next/server";
import { sweepPendingTailoring } from "@/resume/pipeline";
import { withCronLock } from "@/lib/cron-lock";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  try {
    const locked = await withCronLock("tailor", () => sweepPendingTailoring(3));
    if (!locked.ran) {
      return NextResponse.json({ ok: true, skipped: "already running" });
    }
    return NextResponse.json({ ok: true, tailored: locked.result });
  } catch (err) {
    console.error("[cron/tailor] fatal:", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

// cron-job.org / browsers can hit GET; same Bearer auth (middleware).
export async function GET() { return POST(); }
