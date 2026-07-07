/**
 * Alternate-identity resume for the dual-application strategy.
 *
 * The owner applies to every job twice, as two independent candidacies the
 * company's ATS won't merge: the referral flow runs on the personal identity
 * (the resume DMs attach), and the DIRECT application uses this variant — the
 * same master .tex with ONLY the contact block swapped to the alternate
 * email/phone. Deterministic string replacement, no LLM: content identical,
 * contact details different.
 */

import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { uploadResume, isS3Configured } from "@/lib/s3";
import { compileLatex, pdfPageCount } from "./compile";

export interface AltResumeResult {
  ok: boolean;
  detail: string;
  altResumeKey?: string;
}

/** Emails and phone-shaped strings in the master's visible text. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phones as they appear in resumes: +91-80765..., +91 80765..., 8076594383.
const PHONE_RE = /(?:\+\d{1,3}[-\s]?)?\d{10}|\+\d{1,3}[-\s]?\d{4,5}[-\s]?\d{5,6}/g;

export async function generateAltResume(): Promise<AltResumeResult> {
  if (!isS3Configured()) return { ok: false, detail: "S3 not configured" };

  const [profile, settings] = await Promise.all([
    prisma.resumeProfile.findUnique({ where: { id: "default" } }),
    getSettings(),
  ]);
  if (!profile?.masterTex) return { ok: false, detail: "no master .tex saved — add it first" };

  const { email: altEmail, phone: altPhone } = settings.altIdentity;
  if (!altEmail || !altPhone) {
    return { ok: false, detail: "alternate email and phone not set — fill them in on the Resume page" };
  }

  // Swap every email and phone occurrence. LaTeX-escape only what these fields
  // can realistically contain (& _ % #).
  const esc = (s: string) => s.replace(/([&_%#])/g, "\\$1");
  let tex = profile.masterTex;
  const emails = [...new Set(tex.match(EMAIL_RE) ?? [])];
  const phones = [...new Set(tex.match(PHONE_RE) ?? [])];
  if (emails.length === 0) return { ok: false, detail: "no email found in the master .tex to swap" };

  for (const e of emails) tex = tex.split(e).join(esc(altEmail));
  for (const p of phones) tex = tex.split(p).join(esc(altPhone));

  const compiled = await compileLatex(tex);
  if (!compiled.ok) {
    return { ok: false, detail: `alt resume failed to compile: ${compiled.log.slice(-400)}` };
  }
  const pages = pdfPageCount(compiled.pdf!);
  if (compiled.pdf!.length < 10_000 || (pages !== null && pages > 4)) {
    return { ok: false, detail: `alt resume PDF failed sanity check (${compiled.pdf!.length} bytes)` };
  }

  const key = `resume/alt/alt-identity-${Date.now()}.pdf`;
  await uploadResume(key, compiled.pdf!);
  await prisma.resumeProfile.update({ where: { id: "default" }, data: { altResumeKey: key } });

  return {
    ok: true,
    detail: `swapped ${emails.length} email(s) and ${phones.length} phone(s); compiled via ${compiled.provider}`,
    altResumeKey: key,
  };
}
