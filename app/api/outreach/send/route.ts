/**
 * POST /api/outreach/send  { jobIds: string[] }
 * Manual bulk "Send requests" — fires the queued outreach for the selected jobs
 * now (bypasses the send window; respects globalPause + rate caps).
 * Behind basic auth (middleware). Used by the board's bulk-select action bar.
 */

import { NextRequest, NextResponse } from "next/server";
import { sendForJobs } from "@/outreach/outreach-tick";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { jobIds?: string[] };
  const jobIds = Array.isArray(body.jobIds) ? body.jobIds.filter(Boolean) : [];
  if (jobIds.length === 0) {
    return NextResponse.json({ error: "jobIds required" }, { status: 400 });
  }
  const result = await sendForJobs(jobIds);
  return NextResponse.json({ ok: true, ...result });
}
