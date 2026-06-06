/**
 * GET /api/resume/download?key=...  → 302 redirect to a presigned S3 URL.
 */

import { NextRequest, NextResponse } from "next/server";
import { resumeDownloadUrl } from "@/lib/s3";

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });
  const url = await resumeDownloadUrl(key).catch(() => null);
  if (!url) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.redirect(url);
}
