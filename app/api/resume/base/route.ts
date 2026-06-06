/**
 * GET  /api/resume/base  → current base resume metadata + download URL
 * POST /api/resume/base  → upload a new base resume PDF (multipart "file")
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { uploadResume, resumeDownloadUrl, isS3Configured } from "@/lib/s3";

export async function GET() {
  const profile = await prisma.resumeProfile.findUnique({ where: { id: "default" } });
  if (!profile?.baseResumeKey) {
    return NextResponse.json({ baseResumeKey: null, name: null, url: null });
  }
  const url = await resumeDownloadUrl(profile.baseResumeKey).catch(() => null);
  return NextResponse.json({ baseResumeKey: profile.baseResumeKey, name: profile.baseResumeName, url });
}

export async function POST(req: NextRequest) {
  if (!isS3Configured()) {
    return NextResponse.json({ error: "S3 not configured" }, { status: 400 });
  }
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const key = `resume/base/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.]/g, "_")}`;
  await uploadResume(key, buf, file.type || "application/pdf");

  await prisma.resumeProfile.upsert({
    where: { id: "default" },
    create: { id: "default", baseResumeKey: key, baseResumeName: file.name },
    update: { baseResumeKey: key, baseResumeName: file.name },
  });

  const url = await resumeDownloadUrl(key).catch(() => null);
  return NextResponse.json({ ok: true, baseResumeKey: key, name: file.name, url });
}
