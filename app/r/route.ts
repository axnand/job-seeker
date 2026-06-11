/**
 * GET /r  → 302 redirect to the base resume presigned S3 URL.
 * Used as a short, stable link in LinkedIn outreach messages.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resumeDownloadUrl } from "@/lib/s3";

export async function GET() {
  const profile = await prisma.resumeProfile.findUnique({ where: { id: "default" } });
  const key = profile?.baseResumeKey;
  if (!key) return NextResponse.json({ error: "No resume uploaded" }, { status: 404 });
  const url = await resumeDownloadUrl(key).catch(() => null);
  if (!url) return NextResponse.json({ error: "Could not generate download URL" }, { status: 500 });
  return NextResponse.redirect(url);
}
