/**
 * GET  /api/resume/master → { hasMasterTex, vocabularySize, updatedAt }
 * POST /api/resume/master → save the master LaTeX resume source (body: { masterTex })
 *
 * POST verifies the document compiles BEFORE saving, so paste errors surface
 * immediately instead of failing silently during the first tailoring run.
 * Auth: covered by the app-wide middleware like every other /api route.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { compileLatex, pdfPageCount } from "@/resume/compile";
import { buildVocabulary } from "@/resume/whitelist";

export const maxDuration = 120; // compile check can take a while

export async function GET() {
  const profile = await prisma.resumeProfile.findUnique({ where: { id: "default" } });
  return NextResponse.json({
    hasMasterTex: !!profile?.masterTex,
    vocabularySize: Array.isArray(profile?.whitelist) ? (profile!.whitelist as string[]).length : 0,
    updatedAt: profile?.updatedAt ?? null,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { masterTex?: string } | null;
  const masterTex = body?.masterTex?.trim();

  if (!masterTex || !masterTex.includes("\\begin{document}")) {
    return NextResponse.json({ error: "masterTex must be a complete LaTeX document (missing \\begin{document})" }, { status: 400 });
  }

  // Compile check — a master that doesn't compile can never produce tailored PDFs.
  const compiled = await compileLatex(masterTex);
  if (!compiled.ok) {
    return NextResponse.json({
      error: "master resume does not compile — fix it and paste again",
      compileLog: compiled.log.slice(-2000),
    }, { status: 422 });
  }

  const pages = pdfPageCount(compiled.pdf!);
  if (compiled.pdf!.length < 10_000 || (pages !== null && pages > 4)) {
    return NextResponse.json({
      error: `master compiles but the output looks wrong (${compiled.pdf!.length} bytes, ${pages ?? "?"} pages) — check the document`,
    }, { status: 422 });
  }

  const vocabulary = buildVocabulary(masterTex);
  await prisma.resumeProfile.upsert({
    where: { id: "default" },
    create: { id: "default", masterTex, whitelist: vocabulary },
    update: { masterTex, whitelist: vocabulary },
  });

  return NextResponse.json({ ok: true, vocabularySize: vocabulary.length });
}
