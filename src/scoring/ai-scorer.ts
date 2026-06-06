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
}

const SYSTEM_PROMPT = `You are an expert job-fit analyst and salary researcher.
You receive a job description and an owner's resume + preferences.
You MUST respond with a single JSON object — no prose, no markdown fences.`;

function buildPrompt(input: ScoringInput): string {
  const { masterTexPath: resume, targetRoles, preferredIndustries, seniorityLevel } = config.resume;
  const minSal = {
    amount:   input.minSalaryAmount   ?? config.search.minSalary.amount,
    currency: input.minSalaryCurrency ?? config.search.minSalary.currency,
    period:   config.search.minSalary.period,
  };
  const threshold = input.relevanceThreshold ?? config.search.relevanceThreshold;

  const salaryHint = input.sourceSalary?.min
    ? `\nSource-provided salary hint (high trust): ${JSON.stringify(input.sourceSalary)}`
    : "";

  return `## Owner profile
Target roles: ${targetRoles.join(", ")}
Preferred industries: ${preferredIndustries.join(", ")}
Seniority: ${seniorityLevel}
Min target salary: ${minSal.amount} ${minSal.currency}/${minSal.period}
Resume path (reference only): ${resume}
${salaryHint}

## Job
Company: ${input.company}
Role: ${input.role}

## Job Description
${input.jdText.slice(0, 6000)}

## Instructions
1. Score fit 0-100 (resume × preferences × JD).
2. Write a 2-sentence reason.
3. Write a 3-line tailored pitch the owner can use in a LinkedIn DM.
4. Extract or estimate the salary. If stated in the JD use it verbatim. If not, estimate based on role + seniority + company + location. Always provide min, max, currency, period.
5. If score < ${threshold}, set skipReason explaining why.

Respond with ONLY this JSON (no markdown):
{
  "score": <0-100>,
  "reason": "<2 sentences>",
  "tailoredPitch": "<3 lines>",
  "skipReason": null,
  "salary": {
    "min": <number>,
    "max": <number>,
    "currency": "<ISO 4217>",
    "period": "year|month|hour",
    "basis": "stated|estimated",
    "confidence": "high|medium|low"
  }
}`;
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
  }>(result.text);

  // Merge source salary as override if it was stated (higher trust than LLM estimate)
  const rawSalary: RawSalary =
    input.sourceSalary?.basis === "stated"
      ? { ...parsed.salary, ...input.sourceSalary }
      : parsed.salary;

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
  };
}
