/**
 * Serverless LaTeX compilation via external compile services (no Tectonic/WASM
 * on Vercel). Primary: latex.ytotech.com (POST, full log on failure).
 * Fallback: latexonline.cc (GET). Both are best-effort free services — every
 * failure path returns the compiler log so the self-repair loop can react, and
 * the tailoring pipeline falls back to the base resume if compilation is
 * impossible.
 */

export interface CompileResult {
  ok: boolean;
  pdf?: Buffer;
  log: string;      // compiler output (trimmed) — fed to the LLM on self-repair
  provider: string;
}

const YTOTECH_URL = "https://latex.ytotech.com/builds/sync";
const LATEXONLINE_URL = "https://latexonline.cc/compile";

/** Keep only the informative tail of a LaTeX log (errors come last). */
function trimLog(log: string, max = 4000): string {
  const errIdx = log.indexOf("\n!");
  const slice = errIdx >= 0 ? log.slice(errIdx) : log;
  return slice.length <= max ? slice : slice.slice(-max);
}

/** fontspec/\setmainfont documents hard-fail under pdflatex — they need XeLaTeX. */
function compilerFor(tex: string): "pdflatex" | "xelatex" {
  return /\\usepackage(\[[^\]]*\])?\{fontspec\}|\\setmainfont/.test(tex) ? "xelatex" : "pdflatex";
}

async function compileViaYtotech(tex: string): Promise<CompileResult> {
  const res = await fetch(YTOTECH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      compiler: compilerFor(tex),
      resources: [{ main: true, content: tex }],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (res.status === 200 || res.status === 201) {
    const buf = Buffer.from(await res.arrayBuffer());
    // Sanity: a real PDF starts with %PDF
    if (buf.subarray(0, 4).toString() === "%PDF") {
      return { ok: true, pdf: buf, log: "", provider: "ytotech" };
    }
    return { ok: false, log: `ytotech returned non-PDF body (${buf.length} bytes)`, provider: "ytotech" };
  }

  // Error responses are JSON with the compiler logs.
  const text = await res.text().catch(() => "");
  let log = text;
  try {
    const parsed = JSON.parse(text) as { logs?: string; error?: string };
    log = parsed.logs ?? parsed.error ?? text;
  } catch { /* keep raw text */ }
  return { ok: false, log: trimLog(log), provider: "ytotech" };
}

async function compileViaLatexOnline(tex: string): Promise<CompileResult> {
  // GET with the doc in the query string — only viable for smaller documents,
  // which one-page resumes are. URL-encode pushes size ~3x; cap at ~6KB source.
  if (tex.length > 6000) {
    return { ok: false, log: "latexonline fallback skipped: document too large for GET", provider: "latexonline" };
  }
  const url = `${LATEXONLINE_URL}?text=${encodeURIComponent(tex)}&command=${compilerFor(tex)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (res.ok) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 4).toString() === "%PDF") {
      return { ok: true, pdf: buf, log: "", provider: "latexonline" };
    }
  }
  const log = res.ok ? "latexonline returned non-PDF body" : await res.text().catch(() => `HTTP ${res.status}`);
  return { ok: false, log: trimLog(log), provider: "latexonline" };
}

/**
 * Compile LaTeX source to PDF. Tries ytotech, then latexonline. Network-level
 * failures (service down) are reported with ok=false and a log explaining why —
 * the caller decides whether to self-repair (compile error) or give up
 * (infrastructure error).
 */
export async function compileLatex(tex: string): Promise<CompileResult> {
  let primary: CompileResult;
  try {
    primary = await compileViaYtotech(tex);
  } catch (err) {
    primary = { ok: false, log: `ytotech unreachable: ${(err as Error).message}`, provider: "ytotech" };
  }
  if (primary.ok) return primary;

  let fallback: CompileResult;
  try {
    fallback = await compileViaLatexOnline(tex);
  } catch (err) {
    fallback = { ok: false, log: `latexonline unreachable: ${(err as Error).message}`, provider: "latexonline" };
  }
  if (fallback.ok) return fallback;

  // Prefer the primary's log — it's the detailed compiler output.
  return primary.log.length >= fallback.log.length ? primary : fallback;
}

/** True when the log looks like a LaTeX source error (self-repairable) rather
 *  than a service outage (retrying with different source won't help). */
export function isSourceError(result: CompileResult): boolean {
  return /^!|Undefined control sequence|Missing \$|Emergency stop|LaTeX Error|Runaway argument/m.test(result.log);
}

/**
 * Page count of a PDF, or null when it can't be determined. pdflatex recovers
 * from many source errors and still emits a PDF — a sanity check on the output
 * catches "compiled but mangled" results a green compile status would ship.
 * Modern pdflatex compresses object streams, so this often returns null and
 * the caller's byte-size floor is the guard that always applies.
 */
export function pdfPageCount(pdf: Buffer): number | null {
  const text = pdf.toString("latin1");
  // Prefer the page-tree /Count (max across nested /Pages nodes).
  let max = 0;
  for (const m of text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)) {
    max = Math.max(max, Number(m[1]));
  }
  if (max > 0) return max;
  const pages = text.match(/\/Type\s*\/Page\b/g)?.length ?? 0;
  return pages > 0 ? pages : null;
}
