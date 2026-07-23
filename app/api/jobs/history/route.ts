import { NextRequest, NextResponse } from "next/server";
import { parseHistoryParams, fetchHistory } from "@/history/query";

/** GET /api/jobs/history?q=&appStage=&skipSource=&source=&salaryMin=&salaryMax=&dateFrom=&dateTo=&pinned=1&sort=&dir=&page=&pageSize= */
export async function GET(req: NextRequest) {
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const params = parseHistoryParams(sp);
  const result = await fetchHistory(params);
  return NextResponse.json(result);
}
