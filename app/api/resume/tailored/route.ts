/**
 * POST /api/resume/tailored?jobId=...  → upload a tailored resume PDF for a job.
 * Once uploaded, the job's resume gate is satisfied and outreach can proceed.
 */

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { uploadResume, isS3Configured } from "@/lib/s3";

export async function POST(req: NextRequest) {
  if (!isS3Configured()) {
    return NextResponse.json({ error: "S3 not configured" }, { status: 400 });
  }
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const key = `resume/jobs/${jobId}/tailored-${Date.now()}.pdf`;
  await uploadResume(key, buf, file.type || "application/pdf");

  let job;
  try {
    job = await prisma.job.update({
      where: { id: jobId },
      data: { tailoredResumeKey: key },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "job not found" }, { status: 404 });
    }
    throw err;
  }

  return NextResponse.json({ ok: true, tailoredResumeKey: job.tailoredResumeKey });
}
