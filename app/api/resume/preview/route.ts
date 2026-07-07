/**
 * POST /api/resume/preview  → compile arbitrary LaTeX and stream the PDF back.
 *
 * Powers the "compile on our end" live preview: the Resume page posts the
 * current (unsaved) master .tex and renders the returned PDF inline. Nothing is
 * stored — this is a throwaway render. On failure returns JSON { error, log }
 * with the compiler output so the same red log box can explain what broke.
 */

import { NextRequest, NextResponse } from "next/server";
import { compileLatex, pdfPageCount } from "@/resume/compile";

export const maxDuration = 120; // external LaTeX compile

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { tex?: string } | null;
  const tex = body?.tex?.trim();
  if (!tex || !tex.includes("\\begin{document}")) {
    return NextResponse.json({ error: "tex must be a complete LaTeX document (missing \\begin{document})" }, { status: 400 });
  }

  const compiled = await compileLatex(tex);
  if (!compiled.ok) {
    return NextResponse.json({ error: "does not compile", log: compiled.log.slice(-2000) }, { status: 422 });
  }
  const pages = pdfPageCount(compiled.pdf!);
  if (compiled.pdf!.length < 10_000 || (pages !== null && pages > 4)) {
    return NextResponse.json({
      error: `compiles but the output looks wrong (${compiled.pdf!.length} bytes, ${pages ?? "?"} pages)`,
    }, { status: 422 });
  }

  return new NextResponse(new Uint8Array(compiled.pdf!), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline; filename=preview.pdf",
      "Cache-Control": "no-store",
    },
  });
}
