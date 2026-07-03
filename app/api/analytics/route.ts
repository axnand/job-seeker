/**
 * GET /api/analytics
 * One aggregated JSON: per-source conversion funnel, overall funnel totals, and
 * per-stage pipeline counts. See src/analytics/aggregate.ts for the query plan.
 */

import { NextResponse } from "next/server";
import { computeAnalytics } from "@/analytics/aggregate";

export async function GET() {
  const data = await computeAnalytics();
  return NextResponse.json(data);
}
