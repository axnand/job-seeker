/**
 * Cheap pre-scoring triage: a small, cheap model (config.ai.triageModel) with a
 * tiny prompt rejects obvious mismatches before the expensive full scoring call.
 *
 * Cost math: full scoring is a ~3.5K-token prompt on the flagship model, and
 * most discovered jobs FAIL it — so most spend is on rejects. Triage runs the
 * same rejection at ~1/10th the tokens on a ~5x cheaper model; only survivors
 * pay flagship price.
 *
 * IMPORTANT: triage judges seniority / role fit / location ONLY — never pay.
 * Salary is estimated in full scoring so below-owner-floor jobs still get a
 * figure and flow to the friend digest (skipCategory "salary").
 */

import { chatCompletion, parseJsonResponse } from "@/ai/ai-adapter";
import { config } from "@/config";

export interface TriageInput {
  company: string;
  role: string;
  location: string | null;
  jdText: string;
  profile?: { seniorityLevel: string; targetRoles: string[] };
  /** Cheap model override (settings.ai.triageModel); defaults to config. */
  model?: string;
}

export interface TriageResult {
  pass: boolean;
  reason: string; // short phrase, recorded as skipReason for rejects
}

function systemPrompt(input: TriageInput): string {
  const seniority = input.profile?.seniorityLevel ?? config.resume.seniorityLevel;
  const roles = (input.profile?.targetRoles ?? config.resume.targetRoles).join(", ");
  return `You triage job postings for a candidate: ${seniority}. Target roles: ${roles}. Location: India (remote OK).
Respond ONLY with JSON: {"verdict":"pass"|"reject","reason":"<short phrase>"}.

REJECT only when the posting clearly fails one of these:
- Seniority: senior/staff/principal/lead/manager/architect, or 4+ years required.
- Role: not a software-engineering role (sales, support, design, data entry, ...).
- Type: internship, unpaid, contract/temp, part-time.
- Location: on-site/hybrid OUTSIDE India (global/APAC remote is fine).

Everything else passes — INCLUDING low-paying jobs (pay is judged later, never here).
When the posting is ambiguous, pass. A wrong reject loses a real opportunity; a wrong pass only costs one deeper look.`;
}

export async function triageJob(input: TriageInput, providerId?: string): Promise<TriageResult> {
  try {
    const result = await chatCompletion(
      [
        { role: "system", content: systemPrompt(input) },
        {
          role: "user",
          content: `Company: ${input.company}\nRole: ${input.role}\nLocation: ${input.location ?? "unknown"}\n\n${input.jdText.slice(0, 2500)}`,
        },
      ],
      {
        temperature: 0,
        max_tokens: 100,
        response_format: { type: "json_object" },
        purpose: "triage",
        model: input.model ?? config.ai.triageModel,
      },
      providerId
    );
    const parsed = parseJsonResponse<{ verdict?: string; reason?: string }>(result.text);
    if (parsed.verdict === "reject") {
      return { pass: false, reason: (parsed.reason ?? "triage reject").slice(0, 120) };
    }
    return { pass: true, reason: "" };
  } catch (err) {
    // Triage is an optimization — on any failure, fail OPEN so the job still
    // reaches full scoring rather than silently vanishing.
    console.error("[triage] failed open:", (err as Error).message);
    return { pass: true, reason: "" };
  }
}
