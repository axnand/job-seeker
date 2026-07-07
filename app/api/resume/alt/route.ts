/**
 * GET  /api/resume/alt → { altResumeKey, altIdentity } (current state)
 * POST /api/resume/alt → save alt identity { email, phone } and (re)generate
 *                        the alternate-contact resume PDF from the master .tex.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSettings, updateSettings } from "@/lib/settings";
import { generateAltResume } from "@/resume/alt-identity";

export const maxDuration = 120; // external LaTeX compile

export async function GET() {
  const [profile, settings] = await Promise.all([
    prisma.resumeProfile.findUnique({ where: { id: "default" } }),
    getSettings(),
  ]);
  return NextResponse.json({
    altResumeKey: profile?.altResumeKey ?? null,
    altIdentity: settings.altIdentity,
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { email?: string; phone?: string } | null;
  const email = body?.email?.trim();
  const phone = body?.phone?.trim();
  if (!email || !/.+@.+\..+/.test(email) || !phone || phone.replace(/\D/g, "").length < 10) {
    return NextResponse.json({ error: "valid alternate email and phone required" }, { status: 400 });
  }

  await updateSettings({ altIdentity: { email, phone } });
  const result = await generateAltResume();
  if (!result.ok) return NextResponse.json({ error: result.detail }, { status: 422 });
  return NextResponse.json(result);
}
