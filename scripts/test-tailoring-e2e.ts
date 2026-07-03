/**
 * End-to-end functional test of the resume tailoring pipeline, minus DB/S3:
 *   compile master → LLM edit proposal → truthfulness validation → apply →
 *   compile tailored → attack the whitelist → self-repair broken LaTeX.
 *
 * Uses the real OpenAI key from .env.local (only that var is loaded, so the
 * AI adapter falls back to config defaults instead of touching any DB) and the
 * real external LaTeX compile services. Compiled PDFs are written next to this
 * script's fixtures for manual inspection.
 *
 * Run: npx tsx scripts/test-tailoring-e2e.ts
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

// Load ONLY the LLM key before importing app modules (config.ts snapshots env
// at import; leaving DATABASE_URL unset forces the adapter's config fallback).
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^(OPENAI_API_KEY)\s*=\s*"?([^"\n]+)"?\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
}

const JD = `Backend Engineer (SDE-1) — Razorpay, Bangalore (hybrid)
We're looking for an early-career backend engineer to build high-scale payment
infrastructure. You'll work on distributed systems processing millions of
transactions, event-driven pipelines on Kafka, and low-latency Java/Spring Boot
services backed by PostgreSQL. Experience with reactive programming, Docker,
and cloud deployment (AWS) is a strong plus. 0-2 years experience.`;

async function main() {
  const { compileLatex, isSourceError } = await import("../src/resume/compile");
  const { proposeEdits, repairCompileError, MAX_EDITS } = await import("../src/resume/tailor");
  const { buildVocabulary, validateEdits, applyEdits, documentIntroducesClaims } = await import("../src/resume/whitelist");

  const master = readFileSync(resolve(__dirname, "fixtures/master-resume.tex"), "utf8");
  let failures = 0;
  const check = (name: string, cond: boolean, detail?: string) => {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  // ── 1. Master compiles on the real external services ──────────────────────
  console.log("\n[1/5] compiling master resume (external service)...");
  const masterPdf = await compileLatex(master);
  check("master .tex compiles to PDF", masterPdf.ok, masterPdf.log.slice(0, 400));
  if (masterPdf.ok) {
    const p = resolve(__dirname, "fixtures/master-resume.pdf");
    writeFileSync(p, masterPdf.pdf!);
    console.log(`      provider=${masterPdf.provider}, ${masterPdf.pdf!.length} bytes → ${p}`);
  }

  const vocabulary = buildVocabulary(master);

  // ── 2. Attack the truthfulness gate (no LLM needed) ────────────────────────
  console.log("\n[2/5] attacking the truthfulness gate...");
  const attacks = [
    { find: "Java, Spring Boot, Spring WebFlux, Kafka", replace: "Java, Spring Boot, Spring WebFlux, Kafka, Kubernetes, Terraform", why: "" },
    { find: "with 1 year of experience", replace: "with 4 years of experience", why: "" },
    { find: "Hackathon winner.", replace: "Hackathon winner. Ex-Google intern.", why: "" },
  ];
  const attackResults = attacks.map(a => validateEdits([a], master, vocabulary, MAX_EDITS));
  check("invented skills (Kubernetes/Terraform) blocked", attackResults[0].length === 1);
  check("inflated experience (4 years) blocked", attackResults[1].length === 1, JSON.stringify(attackResults[1]));
  check("invented employer (Google) blocked", attackResults[2].length === 1);

  // ── 3. Broken LaTeX is detected and classified repairable (no LLM) ─────────
  // Note: pdflatex nonstop mode RECOVERS from many errors (unclosed braces,
  // undefined commands) and still emits a PDF — a missing \end{document} is a
  // reliably fatal "Emergency stop", which is what the repair loop exists for.
  console.log("\n[3/5] broken-LaTeX detection...");
  const broken = master.replace("\\end{document}", "");
  const brokenResult = await compileLatex(broken);
  check("broken tex fails compilation", !brokenResult.ok);
  check("failure classified as source error (repairable)", isSourceError(brokenResult), brokenResult.log.slice(0, 200));

  // ── 4-5. LLM stages ─────────────────────────────────────────────────────────
  if (!process.env.OPENAI_API_KEY) {
    console.error("\nNO OPENAI_API_KEY — skipping LLM stages (edit proposal, self-repair).");
    process.exit(failures === 0 ? 0 : 1);
  }
  console.log("\n[4/5] proposing edits via LLM (real call)...");
  let proposal;
  try {
    proposal = await proposeEdits({
      masterTex: master,
      vocabulary,
      company: "Razorpay",
      role: "Backend Engineer (SDE-1)",
      jdText: JD,
      tailoringSuggestions: null,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("invalid_api_key") || msg.includes("401")) {
      console.error("\nCREDENTIAL PROBLEM (not a pipeline bug): OpenAI rejected the API key (401).");
      console.error("Fix the key in .env.local and re-run. All non-LLM stages above " + (failures === 0 ? "PASSED." : "had failures."));
      process.exit(2);
    }
    throw err;
  }
  console.log(`      ${proposal.edits.length} edit(s) accepted, ${proposal.rejected.length} rejected by validator`);
  for (const e of proposal.edits) console.log(`      • ${e.why || "(no why)"}\n        - ${e.find.slice(0, 70)}\n        + ${e.replace.slice(0, 70)}`);
  for (const r of proposal.rejected) console.log(`      ✗ rejected: ${r.reason}`);
  check("LLM proposed at least one edit", proposal.edits.length >= 1);
  check(`edit count within budget (≤${MAX_EDITS})`, proposal.edits.length <= MAX_EDITS);
  check("accepted edits re-validate clean", validateEdits(proposal.edits, master, vocabulary, MAX_EDITS).length === 0);

  // Apply + compile the tailored resume
  console.log("      applying edits + compiling tailored resume...");
  const tailoredTex = applyEdits(master, proposal.edits);
  check("tailored tex differs from master", tailoredTex !== master);
  check("tailored tex introduces no new claims", documentIntroducesClaims(tailoredTex, vocabulary).length === 0,
    documentIntroducesClaims(tailoredTex, vocabulary).join(", "));
  const changedLines = tailoredTex.split("\n").filter((l, i) => l !== master.split("\n")[i]).length;
  console.log(`      ${changedLines} line(s) changed out of ${master.split("\n").length} (surgical requirement)`);
  check("edits are surgical (<30% of lines)", changedLines / master.split("\n").length < 0.3);
  const tailoredPdf = await compileLatex(tailoredTex);
  check("tailored .tex compiles to PDF", tailoredPdf.ok, tailoredPdf.log.slice(0, 400));
  if (tailoredPdf.ok) {
    const p = resolve(__dirname, "fixtures/tailored-razorpay.pdf");
    writeFileSync(p, tailoredPdf.pdf!);
    console.log(`      provider=${tailoredPdf.provider}, ${tailoredPdf.pdf!.length} bytes → ${p}`);
  }

  // ── 5. LLM self-repair on the broken LaTeX from stage 3 ────────────────────
  console.log("\n[5/5] LLM self-repair of broken LaTeX...");
  const repaired = await repairCompileError(broken, brokenResult.log);
  check("LLM produced a repair", repaired !== null);
  if (repaired) {
    check("repair smuggles no new claims", documentIntroducesClaims(repaired, vocabulary).length === 0,
      documentIntroducesClaims(repaired, vocabulary).join(", "));
    const repairedPdf = await compileLatex(repaired);
    check("repaired tex compiles to PDF", repairedPdf.ok, repairedPdf.log.slice(0, 400));
  }

  console.log(failures === 0 ? "\nE2E: all checks passed." : `\nE2E: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error("E2E fatal:", err); process.exit(1); });
