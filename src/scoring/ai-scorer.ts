/**
 * Single LLM call: produces relevance score + tailored pitch + salary extraction.
 * Salary and scoring share one prompt to avoid extra API cost.
 */

import { chatCompletion, parseJsonResponse } from "@/ai/ai-adapter";
import { normalizeSalary, salaryGate, type RawSalary } from "@/salary/normalize";
import { config } from "@/config";

export interface ScoringInput {
  jdText: string;
  company: string;
  role: string;
  /** Structured salary from the source, if available (higher-trust hint). */
  sourceSalary?: RawSalary;
  /** Override config defaults with DB settings values. */
  relevanceThreshold?: number;
  minSalaryAmount?: number;
  minSalaryCurrency?: string;
  strictSalary?: boolean;
}

export interface ScoringOutput {
  score: number;
  reason: string;
  tailoredPitch: string;
  skipReason: string | null;
  salary: RawSalary;
  salaryFlagReason?: string;
  /** Normalized annual base in config.search.baseCurrency — null if unknown */
  salaryAnnualBase?: number;
  /** Resume tailoring gate */
  needsTailoring: boolean;
  tailoringSuggestions: string | null;
}

const SYSTEM_PROMPT = `You are a sharp job-fit analyst screening roles for a specific early-career candidate.
You are deliberately strict: a bad match wastes the candidate's time and outreach quota.
You MUST respond with a single JSON object — no prose, no markdown fences.`;

function buildPrompt(input: ScoringInput): string {
  const { summary, targetRoles, preferredIndustries, constraints } = config.resume;
  const minSal = {
    amount:   input.minSalaryAmount   ?? config.search.minSalary.amount,
    currency: input.minSalaryCurrency ?? config.search.minSalary.currency,
  };
  const threshold = input.relevanceThreshold ?? config.search.relevanceThreshold;
  const minLPA = (minSal.amount / 100000).toFixed(1);

  const salaryHint = input.sourceSalary?.min
    ? `\nSource-provided salary (high trust — prefer this over your own estimate): ${JSON.stringify(input.sourceSalary)}`
    : "";

  return `## Candidate
${summary}

Target roles: ${targetRoles.join(", ")}
Preferred industries: ${preferredIndustries.join(", ")}
Acceptable seniority: ${constraints.acceptableSeniority.join(", ")}
HARD REJECT seniority: ${constraints.rejectSeniority.join(", ")}
Current base: ${constraints.currentBaseLPA} LPA. Minimum acceptable base: ${minLPA} LPA (anything at/below is a pay cut).

## Job
Company: ${input.company}
Role: ${input.role}
${salaryHint}

## Job Description
${input.jdText.slice(0, 6000)}

## Scoring rubric (be strict — most jobs should NOT pass)
Start at a baseline and adjust:
- SENIORITY MISMATCH (most important): If this is a senior / staff / principal / lead / EM / architect role, or requires 4+ years of experience → score 0-25. The candidate is a 2026 new grad with ~1 year; they cannot get these. Hard fail.
- If it's an internship, unpaid, or contract/temp → score 0-20.
- PAY: If the salary (stated or your best estimate) is at or below ${minLPA} LPA base → score 0-35 (it's a lateral move or pay cut). Reward roles clearly above ${minLPA} LPA.
- STACK FIT: Reward overlap with Java/Spring Boot/Kafka/Node/TypeScript/backend/distributed systems/full-stack. Non-engineering roles (sales, design, marketing, copywriter, recruiter) → score 0-15.
- LEVEL FIT: Reward explicit "new grad", "graduate", "entry-level", "SDE-1", "associate", "Software Engineer I", "0-2 years", "1-3 years" roles. This is the sweet spot.
- LOCATION (hard rule): Candidate lives in India and cannot relocate. ACCEPT only: (a) jobs located in India, or (b) fully-remote jobs open to India / global-remote / APAC. HARD REJECT (score 0-15) any role that is on-site or hybrid in another country (US/UK/EU/etc.) with no India or remote-for-India option — there is no point surfacing these. A US "remote" role that is actually US-only also fails.
- COMPANY QUALITY: Slight bonus for strong product companies / well-funded startups that reliably pay above ${minLPA} LPA for new grads (e.g. Salesforce, Atlassian, Google, Microsoft, Uber, Razorpay, etc.).

## Tasks
1. Score 0-100 per the rubric above.
2. reason: 2 sentences — explicitly mention seniority fit, pay vs ${minLPA} LPA, and stack fit.
3. tailoredPitch: 3 lines the candidate can paste into a LinkedIn DM (specific to this role + their backend/distributed-systems background).
4. salary: extract if stated, else estimate from role + level + company + India market. For India roles use INR. CRITICAL: min/max must be the FULL absolute amount in the base currency unit — e.g. 18 LPA = 1800000 (rupees/year), NOT 18 and NOT in lakhs. period MUST be exactly one of "year" | "month" | "hour" (never "LPA"/"annum").
5. RESUME TAILORING: The candidate's base resume (above) is strong and general. Decide if it should be tailored BEFORE applying/outreach. Default to needsTailoring=false — only set true when the JD emphasizes specific skills/keywords/domains that are present in the candidate's experience but NOT prominent in the base resume, and surfacing them would materially help (e.g. a specific framework, domain like payments/fintech, or a keyword an ATS would screen on). If true, tailoringSuggestions = 2-4 SPECIFIC, concrete edits (what to add/emphasize and where), each truthful to the candidate's actual background — never invent skills they lack. If false, set tailoringSuggestions to null.
6. If score < ${threshold}, set skipReason (one short phrase, e.g. "senior role - 5+ yrs required", "below 14.5 LPA", "non-engineering").

Respond with ONLY this JSON (no markdown):
{
  "score": <0-100>,
  "reason": "<2 sentences>",
  "tailoredPitch": "<3 lines>",
  "skipReason": null,
  "salary": { "min": <number>, "max": <number>, "currency": "<ISO 4217>", "period": "year|month|hour", "basis": "stated|estimated", "confidence": "high|medium|low" },
  "needsTailoring": <true|false>,
  "tailoringSuggestions": "<specific edits, or null>"
}`;
}

/**
 * Defends against LLM salary quirks:
 *  - period given as "LPA"/"annum"/"per year" → "year"
 *  - Indian lakh convention (e.g. min:15 meaning 15 LPA) → multiply to absolute rupees
 */
function sanitizeSalary(s: RawSalary): RawSalary {
  if (!s) return s;
  const rawPeriod = (s.period as string | undefined)?.toLowerCase() ?? "year";
  // ONLY "lpa"/"lakh" signal the lakh convention — NOT "year".
  const saidLakh = /lpa|lakh/.test(rawPeriod);

  let period: "year" | "month" | "hour" = "year";
  if (rawPeriod.includes("month")) period = "month";
  else if (rawPeriod.includes("hour")) period = "hour";

  let min = s.min ?? undefined;
  let max = s.max ?? undefined;
  const currency = (s.currency ?? "INR").toUpperCase();

  // Lakh convention: INR annual where the LLM said "LPA" OR gave a number too
  // small to be an absolute annual salary (e.g. 15 meaning ₹15 lakh).
  const ref = max ?? min ?? 0;
  const looksLikeLakhs = currency === "INR" && period === "year" && (saidLakh || (ref > 0 && ref < 1000));
  if (looksLikeLakhs) {
    if (typeof min === "number") min *= 100000;
    if (typeof max === "number") max *= 100000;
  }

  return { ...s, min, max, currency, period };
}

export async function scoreJob(
  input: ScoringInput,
  providerId?: string
): Promise<ScoringOutput> {
  const result = await chatCompletion(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildPrompt(input) },
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
    tailoringSuggestions?: string | null;
  }>(result.text);

  // Merge source salary as override if it was stated (higher trust than LLM estimate)
  const rawSalary: RawSalary = sanitizeSalary(
    input.sourceSalary?.basis === "stated"
      ? { ...parsed.salary, ...input.sourceSalary }
      : parsed.salary
  );

  const minAnnual  = input.minSalaryAmount    ?? config.search.minSalary.amount;
  const normalized = await normalizeSalary(rawSalary, input.minSalaryCurrency ?? config.search.minSalary.currency);
  const gate = salaryGate(normalized, minAnnual, input.strictSalary ?? config.search.strictSalary);

  // Auto-skip if below salary and gate says fail
  let skipReason = parsed.skipReason;
  if (!skipReason && !gate.pass) {
    skipReason = gate.reason ?? "salary_below_threshold";
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(parsed.score))),
    reason: parsed.reason,
    tailoredPitch: parsed.tailoredPitch,
    skipReason,
    salary: rawSalary,
    salaryFlagReason: gate.reason && gate.pass && gate.reason !== "salary_unknown_kept"
      ? gate.reason
      : undefined,
    salaryAnnualBase: normalized?.annualBase,
    needsTailoring: parsed.needsTailoring === true,
    tailoringSuggestions: parsed.needsTailoring === true ? (parsed.tailoringSuggestions ?? null) : null,
  };
}
