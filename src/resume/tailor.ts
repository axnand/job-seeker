/**
 * LLM edit proposal for surgical resume tailoring.
 *
 * The model never writes LaTeX documents — it proposes a SHORT list of exact
 * find/replace edits against the master .tex. Edits are validated by
 * whitelist.validateEdits (existence, uniqueness, brace balance, truthfulness
 * vocabulary); violations are fed back for one repair round, then the job
 * proceeds with however many clean edits survived (zero edits = use base PDF).
 */

import { chatCompletion, parseJsonResponse } from "@/ai/ai-adapter";
import { validateEdits, type TailorEdit, type EditViolation } from "./whitelist";

export const MAX_EDITS = 6;

export interface TailorProposal {
  edits: TailorEdit[];
  rejected: EditViolation[];
}

function systemPrompt(masterTex: string, enforceTruthfulness: boolean): string {
  // Rule 3 flips with the truthfulness setting. Strict = never invent anything.
  // Relaxed = may add adjacent, JD-relevant skills/keywords, but employers,
  // titles, degrees and dates must stay real (no fabricated experience/history).
  const rule3 = enforceTruthfulness
    ? `3. TRUTHFULNESS (hard rule): the replacement may only reorder, rephrase, or emphasize facts already present in the resume. NEVER introduce a technology, tool, framework, company, metric, credential, or claim that the master resume does not contain. If the JD wants a skill the candidate lacks, DO NOT add it.`
    : `3. TRUTHFULNESS (relaxed): you MAY add adjacent, JD-relevant SKILLS or KEYWORDS the candidate could realistically pick up quickly, even if not in the master — but keep it plausible and close to their real background. HARD LIMITS even in this mode: never fabricate employers, job titles, degrees, dates, or specific quantified metrics/achievements. Only skills/tools/keywords may be added; work history stays real.`;
  return `You are a precise resume-tailoring engine. You receive a candidate's master LaTeX resume and one job description. You propose at most ${MAX_EDITS} surgical text edits that make the resume speak to THIS job.

## The candidate's master resume (LaTeX source — the ONLY source of truth)
${masterTex}

## Edit rules (violations are rejected by a validator, so follow them exactly)
1. Each edit = {"find": "<exact substring copied verbatim from the LaTeX above>", "replace": "<replacement>", "why": "<one line tying it to the JD>"}.
2. "find" must be copied character-for-character (including LaTeX commands and spacing) and must be UNIQUE in the document — include enough surrounding context to disambiguate.
${rule3}
4. Stay surgical: prefer 2-4 high-impact edits over ${MAX_EDITS} cosmetic ones. Typical good edits: swap which bullet leads a section, rephrase a bullet to mirror the JD's vocabulary (using the candidate's real facts), reorder a skills list so the JD-relevant items come first, adjust the summary line's emphasis.
5. Preserve LaTeX validity: keep every \\command, brace, and environment intact; replace only human-visible text. Escape special characters exactly as the master does (\\%, \\&, \\#).
6. If the resume already fits the job well, return fewer edits or none.

Respond ONLY with JSON: {"edits": [{"find": "...", "replace": "...", "why": "..."}]}`;
}

function userPrompt(company: string, role: string, jdText: string, suggestions: string | null): string {
  return `## Target job
Company: ${company}
Role: ${role}
${suggestions ? `\n## Tailoring hints from the screening pass\n${suggestions}\n` : ""}
## Job description
${jdText.slice(0, 5000)}`;
}

interface RawProposal { edits?: Array<Partial<TailorEdit>> }

function coerce(raw: RawProposal): TailorEdit[] {
  return (raw.edits ?? [])
    .filter(e => typeof e?.find === "string" && typeof e?.replace === "string" && e.find !== e.replace)
    .map(e => ({ find: e.find as string, replace: e.replace as string, why: typeof e.why === "string" ? e.why : "" }))
    .slice(0, MAX_EDITS + 2); // hard cap even before validation
}

/**
 * Propose + validate edits. One repair round: validator feedback goes back to
 * the model, then whatever passes is returned (rejected edits are reported,
 * not silently dropped — they land in Job.tailorLog).
 */
export async function proposeEdits(input: {
  masterTex: string;
  vocabulary: string[];
  company: string;
  role: string;
  jdText: string;
  tailoringSuggestions: string | null;
  providerId?: string;
  /** Whether the whitelist truthfulness gate is enforced (settings.ai.truthfulTailoring). Default true. */
  enforceTruthfulness?: boolean;
}): Promise<TailorProposal> {
  const enforceTruthfulness = input.enforceTruthfulness !== false;
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt(input.masterTex, enforceTruthfulness) },
    { role: "user", content: userPrompt(input.company, input.role, input.jdText, input.tailoringSuggestions) },
  ];

  let edits: TailorEdit[] = [];
  let violations: EditViolation[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await chatCompletion(
      messages,
      { temperature: 0.2, response_format: { type: "json_object" }, purpose: "tailoring" },
      input.providerId
    );
    edits = coerce(parseJsonResponse<RawProposal>(result.text));
    violations = validateEdits(edits, input.masterTex, input.vocabulary, MAX_EDITS, { enforceTruthfulness });
    if (violations.length === 0) return { edits, rejected: [] };

    // Repair round: tell the model exactly what was rejected and why.
    messages.push({ role: "assistant", content: JSON.stringify({ edits }) });
    messages.push({
      role: "user",
      content: `The validator rejected some edits:\n${violations.map(v => `- find:"${v.edit.find?.slice(0, 60)}..." → ${v.reason}`).join("\n")}\n\nReturn the corrected full JSON edit list. Drop any edit you cannot fix without violating the truthfulness rule.`,
    });
  }

  // Second attempt still has violations → keep only the clean edits. Cap at
  // MAX_EDITS too: a "too many edits" violation references only the first
  // overflow edit, so filtering alone can still leave an oversized list that
  // would fail the pipeline's final validation and hard-fail the job.
  const bad = new Set(violations.map(v => v.edit));
  return { edits: edits.filter(e => !bad.has(e)).slice(0, MAX_EDITS), rejected: violations };
}

/**
 * Self-repair for compile errors: given the failing .tex and the compiler log,
 * ask the model for a minimal fix of the BROKEN PART only. Returns repaired
 * full source, or null if the model can't produce one.
 */
export async function repairCompileError(
  brokenTex: string,
  compilerLog: string,
  providerId?: string
): Promise<string | null> {
  const result = await chatCompletion(
    [
      {
        role: "system",
        content: "You fix LaTeX compile errors with minimal changes. You receive a .tex document and its compiler error log. Return ONLY JSON: {\"fixedTex\": \"<the complete corrected document>\"}. Change as little as possible — fix the syntax error, do not rewrite content, do not add or remove claims.",
      },
      { role: "user", content: `## Compiler log\n${compilerLog.slice(0, 3000)}\n\n## Document\n${brokenTex}` },
    ],
    { temperature: 0, response_format: { type: "json_object" }, max_tokens: 8192, purpose: "tailor_repair" },
    providerId
  );
  try {
    const parsed = parseJsonResponse<{ fixedTex?: string }>(result.text);
    return typeof parsed.fixedTex === "string" && parsed.fixedTex.includes("\\begin{document}")
      ? parsed.fixedTex
      : null;
  } catch {
    return null;
  }
}
