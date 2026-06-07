/**
 * Single LLM call: produces relevance score + tailored pitch + salary extraction.
 *
 * Prompt caching strategy:
 *   - SYSTEM message = static candidate profile (resume, constraints, rubric).
 *     This never changes between jobs in the same run.
 *     OpenAI caches automatically when the prefix is identical across calls.
 *   - USER message = only the dynamic part (company, role, JD, salary hint).
 *     Each job gets a different user message; the shared system prefix hits cache.
 */

import { chatCompletion, parseJsonResponse } from "@/ai/ai-adapter";
import { normalizeSalary, salaryGate, type RawSalary } from "@/salary/normalize";
import { config } from "@/config";

export interface ScoringInput {
  jdText: string;
  company: string;
  role: string;
  sourceSalary?: RawSalary;
  relevanceThreshold?: number;
  minSalaryAmount?: number;
  minSalaryCurrency?: string;
  strictSalary?: boolean;
  profile?: {
    summary: string;
    targetRoles: string[];
    preferredIndustries: string[];
    seniorityLevel: string;
    currentBaseLPA: number;
    acceptableSeniority: string[];
    rejectSeniority: string[];
  };
}

export interface ScoringOutput {
  score: number;
  reason: string;
  tailoredPitch: string;
  skipReason: string | null;
  salary: RawSalary;
  salaryFlagReason?: string;
  salaryAnnualBase?: number;
  needsTailoring: boolean;
  tailoringSuggestions: string | null;
}

// ─── System prompt (static — benefits from OpenAI/Anthropic prefix caching) ──

function buildSystemPrompt(input: ScoringInput): string {
  const p = input.profile;
  const summary             = p?.summary             ?? config.resume.summary;
  const targetRoles         = p?.targetRoles         ?? config.resume.targetRoles;
  const preferredIndustries = p?.preferredIndustries ?? config.resume.preferredIndustries;
  const constraints = {
    acceptableSeniority: p?.acceptableSeniority ?? config.resume.constraints.acceptableSeniority,
    rejectSeniority:     p?.rejectSeniority     ?? config.resume.constraints.rejectSeniority,
    currentBaseLPA:      p?.currentBaseLPA      ?? config.resume.constraints.currentBaseLPA,
  };
  const minLPA = ((input.minSalaryAmount ?? config.search.minSalary.amount) / 100000).toFixed(1);
  const threshold = input.relevanceThreshold ?? config.search.relevanceThreshold;

  return `You are a sharp job-fit analyst screening roles for a specific early-career candidate.
You are deliberately strict: a bad match wastes the candidate's time and outreach quota.
You MUST respond with a single JSON object — no prose, no markdown fences.

## Candidate background
${summary}

Target roles: ${targetRoles.join(", ")}
Preferred industries: ${preferredIndustries.join(", ")}
Acceptable seniority: ${constraints.acceptableSeniority.join(", ")}
HARD REJECT seniority: ${constraints.rejectSeniority.join(", ")}
Current FIXED BASE salary: ${constraints.currentBaseLPA} LPA. Minimum acceptable FIXED BASE: ${minLPA} LPA.
IMPORTANT: Compare only against fixed/guaranteed base salary — NOT CTC, NOT total comp, NOT variable pay, NOT bonuses, NOT ESOPs/RSUs. In India, CTC often includes PF, gratuity, variable bonus, and ESOPs which are not guaranteed. A role offering ₹25L CTC with ₹10L base is below the floor.

## Scoring rubric (be strict — most jobs should NOT pass)
- SENIORITY MISMATCH (most important): Senior / staff / principal / lead / EM / architect, or 4+ years required → score 0-25. Hard fail.
- Internship / unpaid / contract / temp → score 0-20.
- PAY (base salary only — NOT CTC): Fixed/guaranteed base at or below ${minLPA} LPA → score 0-35. If the stated salary is CTC-inclusive (mentions PF, variable, ESOPs, gratuity), estimate the fixed base as 60-70% of CTC for a junior role in India. Reward roles with a clear base above ${minLPA} LPA.
- STACK FIT: Reward Java/Spring Boot/Kafka/Node/TypeScript/backend/distributed/full-stack. Non-engineering → score 0-15.
- LEVEL FIT: Reward "new grad", "entry-level", "SDE-1", "associate", "Software Engineer I", "0-2 years", "1-3 years".
- LOCATION (hard rule): India only. ACCEPT: (a) jobs in India, (b) global-remote/APAC-remote. HARD REJECT on-site/hybrid outside India → score 0-15.
- COMPANY QUALITY: Slight bonus for strong product companies / well-funded startups reliably paying above ${minLPA} LPA.

## Tasks
1. Score 0-100 per the rubric.
2. reason: 2 sentences — seniority fit, pay vs ${minLPA} LPA, stack fit.
3. tailoredPitch: 3 lines the candidate can paste into a LinkedIn DM. Rules:
   - Use ONLY real, specific facts from their background (e.g. "built Kafka pipelines processing 500K records" — NOT "strong background in").
   - Start with the most impressive, concrete thing they've done that maps to THIS JD.
   - NO filler: no "excited about your innovative approach", no "I believe I can contribute", no "looking forward to", no "strong background in X".
   - NO bracket placeholders like [Name], [Company], [Role] — must be complete and ready to send.
   - NO opening salutation — just the 3-line pitch itself.
4. salary: Extract or estimate the FIXED BASE salary only — not CTC.
   - If the JD states a base salary range explicitly → use it, basis="stated".
   - If the JD only states CTC → estimate fixed base as ~60-70% of CTC (Indian junior-role norm), basis="estimated", confidence="medium".
   - If no salary info → estimate base from role + seniority + company + India market, basis="estimated".
   - min/max = FULL rupee amount (18 LPA base = 1800000). period = "year"|"month"|"hour" only. currency = "INR" for India roles.
5. RESUME TAILORING: needsTailoring=false by default. Set true only when the JD emphasizes skills in the candidate's background but not prominent in the base resume, AND surfacing them would materially help. If true, tailoringSuggestions = 2-4 concrete edits (truthful only — never invent skills). If false, tailoringSuggestions = null.
6. If score < ${threshold}, set skipReason (short phrase, e.g. "senior role 5+ yrs", "below ${minLPA} LPA", "non-engineering", "US-only on-site").

Respond ONLY with this JSON (no markdown):
{
  "score": <0-100>,
  "reason": "<2 sentences>",
  "tailoredPitch": "<3 lines — no bracket placeholders>",
  "skipReason": null,
  "salary": { "min": <number>, "max": <number>, "currency": "<ISO 4217>", "period": "year|month|hour", "basis": "stated|estimated", "confidence": "high|medium|low" },
  "needsTailoring": <true|false>,
  "tailoringSuggestions": "<specific edits, or null>"
}`;
}

// ─── User prompt (dynamic — one per job) ─────────────────────────────────────

function buildUserPrompt(input: ScoringInput): string {
  const salaryHint = input.sourceSalary?.min
    ? `\nSource-provided salary (high trust): ${JSON.stringify(input.sourceSalary)}`
    : "";

  return `## Job
Company: ${input.company}
Role: ${input.role}
${salaryHint}

## Job Description
${input.jdText.slice(0, 6000)}`;
}

// ─── Sanitize LLM bracket placeholders ───────────────────────────────────────

/**
 * Strips unfilled LLM bracket placeholders like [Name], [Company], [Role],
 * [Hiring Manager's Name], etc. from the pitch before it's embedded in DMs.
 * Also strips leading salutations ("Hi [Hiring Manager's Name],") that the LLM
 * sometimes generates despite instructions — the DM template already has its own greeting.
 */
export function sanitizePitch(pitch: string): string {
  return pitch
    .replace(/\s*—\s*/g, ", ")          // em dash → comma (reads naturally in a DM)
    .replace(/\s*–\s*/g, "-")           // en dash → plain hyphen
    // Strip leading salutations before bracket removal so "Hi [Hiring Manager's Name],"
    // gets consumed whole rather than leaving a dangling "Hi ," in the message.
    .replace(/^(?:Hi|Hey|Dear|Hello)\b[^,\n]*,\s*/i, "")
    .replace(/\[([^\]]{1,50})\]/g, (_, inner) => {
      // Keep things like "[BPIT]" that are actual acronyms/names in the candidate's
      // background — only strip phrases that look like template placeholders.
      const looksLikePlaceholder = /name|manager|company|role|position|department|title|recruiter|team/i.test(inner);
      return looksLikePlaceholder ? "" : `[${inner}]`;
    })
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function coerceSuggestions(v: string | string[] | null | undefined): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean).join("\n• ").replace(/^/, "• ");
  return String(v).trim() || null;
}

function sanitizeSalary(s: RawSalary): RawSalary {
  if (!s) return s;
  const rawPeriod = (s.period as string | undefined)?.toLowerCase() ?? "year";
  const saidLakh = /lpa|lakh/.test(rawPeriod);
  let period: "year" | "month" | "hour" = "year";
  if (rawPeriod.includes("month")) period = "month";
  else if (rawPeriod.includes("hour")) period = "hour";
  let min = s.min ?? undefined;
  let max = s.max ?? undefined;
  const currency = (s.currency ?? "INR").toUpperCase();
  const ref = max ?? min ?? 0;
  const looksLikeLakhs = currency === "INR" && period === "year" && (saidLakh || (ref > 0 && ref < 1000));
  if (looksLikeLakhs) {
    if (typeof min === "number") min *= 100000;
    if (typeof max === "number") max *= 100000;
  }
  return { ...s, min, max, currency, period };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function scoreJob(
  input: ScoringInput,
  providerId?: string
): Promise<ScoringOutput> {
  const result = await chatCompletion(
    [
      // System = static candidate profile + rubric → cached by OpenAI automatically
      // when the prefix is identical across calls in the same run.
      { role: "system", content: buildSystemPrompt(input) },
      // User = only the dynamic part (company + role + JD).
      { role: "user", content: buildUserPrompt(input) },
    ],
    { temperature: 0.2, response_format: { type: "json_object" } },
    providerId
  );

  const parsed = parseJsonResponse<{
    score: number;
    reason: string;
    tailoredPitch: string;
    skipReason: string | null;
    salary: RawSalary;
    needsTailoring?: boolean;
    tailoringSuggestions?: string | string[] | null;
  }>(result.text);

  const rawSalary: RawSalary = sanitizeSalary(
    input.sourceSalary?.basis === "stated"
      ? { ...parsed.salary, ...input.sourceSalary }
      : parsed.salary
  );

  const minAnnual  = input.minSalaryAmount ?? config.search.minSalary.amount;
  const normalized = await normalizeSalary(rawSalary, input.minSalaryCurrency ?? config.search.minSalary.currency);
  const gate       = salaryGate(normalized, minAnnual, input.strictSalary ?? config.search.strictSalary);

  let skipReason = parsed.skipReason;
  if (!skipReason && !gate.pass) skipReason = gate.reason ?? "salary_below_threshold";

  return {
    score:          Math.max(0, Math.min(100, Math.round(parsed.score))),
    reason:         parsed.reason,
    tailoredPitch:  sanitizePitch(parsed.tailoredPitch ?? ""),
    skipReason,
    salary:         rawSalary,
    salaryFlagReason: gate.reason && gate.pass && gate.reason !== "salary_unknown_kept" ? gate.reason : undefined,
    salaryAnnualBase: normalized?.annualBase,
    needsTailoring:   parsed.needsTailoring === true,
    tailoringSuggestions: parsed.needsTailoring === true ? coerceSuggestions(parsed.tailoringSuggestions) : null,
  };
}
