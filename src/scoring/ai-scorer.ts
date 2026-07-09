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

/** Which rubric rule sank a below-threshold job. "salary" means the role is a
 *  fine fit but pays under the owner's floor — the friend digest re-uses those. */
export type SkipCategory = "salary" | "seniority" | "location" | "role_fit" | "other";

export interface ScoringOutput {
  score: number;
  reason: string;
  tailoredPitch: string;
  skipReason: string | null;
  skipCategory: SkipCategory | null;
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
- PAY (base salary only — NOT CTC): Fixed/guaranteed base at or below ${minLPA} LPA → score 0-35. If the stated salary is CTC-inclusive (mentions PF, variable, ESOPs, gratuity), estimate the fixed base as 60-70% of CTC for a junior role in India. Reward roles with a clear base above ${minLPA} LPA. For IT-services / consulting / SI firms (see anchors in task 4) assume a LOW junior base unless the JD explicitly states otherwise — do not give them the benefit of the doubt.
- STACK FIT: Reward Java/Spring Boot/Kafka/Node/TypeScript/backend/distributed/full-stack. Non-engineering → score 0-15.
- LEVEL FIT: Reward "new grad", "entry-level", "SDE-1", "associate", "Software Engineer I", "0-2 years", "1-3 years".
- LOCATION (hard rule): India only. ACCEPT: (a) jobs in India, (b) global-remote/APAC-remote. HARD REJECT on-site/hybrid outside India → score 0-15.
- COMPANY QUALITY: Slight bonus for strong product companies / well-funded startups reliably paying above ${minLPA} LPA. Legacy enterprise, IT services, banking-tech, or companies you are not confident about get NO bonus — assume low pay unless base is explicitly stated.

## Tasks
1. Score 0-100 per the rubric.
2. reason: 2 sentences — seniority fit, pay vs ${minLPA} LPA, stack fit.
3. tailoredPitch: 3 lines the candidate can paste into a LinkedIn DM. Rules:
   - Use ONLY real, specific facts from their background (e.g. "built Kafka pipelines processing 500K records" — NOT "strong background in").
   - Start with the most impressive, concrete thing they've done that maps to THIS JD.
   - NO filler: no "excited about your innovative approach", no "I believe I can contribute", no "looking forward to", no "strong background in X".
   - NO bracket placeholders like [Name], [Company], [Role] — must be complete and ready to send.
   - NO opening salutation — just the 3-line pitch itself.
4. salary: Determine the FIXED BASE salary (annual) — never CTC, never total comp.
   PRIORITY:
   a. JD explicitly states a base salary range → use it verbatim. basis="stated", confidence="high".
   b. JD states only CTC → fixed base ≈ 60-70% of CTC (Indian junior norm). basis="estimated", confidence="medium".
   c. NO salary stated → you must ESTIMATE from company + role + India market. basis="estimated".
      This is a GUESS, so BIAS LOW. An over-estimate makes a bad role pass and burns the candidate's limited outreach quota — that is the worst outcome, far worse than under-estimating.
   CONFIDENCE RULES (strict):
   - confidence="high" ONLY for an explicitly stated base. NEVER for a guess.
   - confidence="medium" only when the company's junior pay band is genuinely well-known (a large IT-services firm that reliably pays low, or a top product company that reliably pays high).
   - otherwise confidence="low".
   INDIA JUNIOR (0-2 yr) BASE ANCHORS — use these, do NOT inflate:
   - IT services / consulting / SI (TCS, Infosys, Wipro, HCL, Cognizant, Capgemini, CGI, Accenture, LTIMindtree, Tech Mahindra, Mphasis, DXC, Genpact, Hexaware, Birlasoft, and similar): typically 3.5-8 LPA base. Almost never clear the ${minLPA} LPA floor → estimate LOW, confidence="medium".
   - Legacy enterprise software / payment & banking tech (ACI Worldwide, Fiserv, FIS, NCR, Jack Henry, Temenos, Finastra, Tata Consultancy Financial, Oracle Financial Services, Intellect Design, Mphasis, IBS Group, and similar): typically 6-12 LPA base for junior roles in India. DO NOT treat these as top-tier product companies — estimate LOW, confidence="medium".
   - Mid-tier / unknown Indian product or startup companies: typically 8-16 LPA base. When company quality is unclear, bias toward the lower end.
   - Strong VC-funded product companies / FAANG-adjacent / global-remote (Google, Microsoft, Amazon, Atlassian, Intuit, Razorpay, CRED, Zepto, Meesho, slice, etc.): typically 16-35 LPA base.
   When torn between two bands, pick the LOWER one.
   DECISIVE RULE FOR UNFAMILIAR COMPANIES: if you cannot name THIS company's real Indian junior pay band from genuine knowledge, treat it as UNKNOWN → confidence="low" and use the IT-services anchor (6-10 LPA). Never round an unfamiliar company UP to a product-company band — unfamiliar ≈ low pay until proven otherwise.
   REALITY CHECK: Indian junior base medians on AmbitionBox / Glassdoor / Levels.fyi run notably LOWER than US-centric assumptions. Anchor to Indian market reality, not to global figures for the same job title.
   - min/max = FULL rupee amount (18 LPA base = 1800000). period = "year"|"month"|"hour" only. currency = "INR" for India roles.
5. RESUME TAILORING: needsTailoring=false by default. Set true only when the JD emphasizes skills in the candidate's background but not prominent in the base resume, AND surfacing them would materially help. If true, tailoringSuggestions = 2-4 concrete edits (truthful only — never invent skills). If false, tailoringSuggestions = null.
6. If score < ${threshold}, set skipReason (short phrase, e.g. "senior role 5+ yrs", "below ${minLPA} LPA", "non-engineering", "US-only on-site") AND skipCategory — the ONE rubric rule that sank it:
   - "salary": good role fit but pay below the floor (this is the ONLY problem)
   - "seniority": senior/staff/lead or too many years required
   - "location": outside India / on-site abroad
   - "role_fit": non-engineering or wrong stack
   - "other": anything else
   If several rules failed, pick the most disqualifying NON-salary one — "salary" means salary was the sole blocker.

Respond ONLY with this JSON (no markdown):
{
  "score": <0-100>,
  "reason": "<2 sentences>",
  "tailoredPitch": "<3 lines — no bracket placeholders>",
  "skipReason": null,
  "skipCategory": null,
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
  // The LLM occasionally emits min/max reversed; a min above max would skew the
  // midpoint the salary gate uses. Order them.
  if (typeof min === "number" && typeof max === "number" && min > max) {
    [min, max] = [max, min];
  }
  return { ...s, min, max, currency, period };
}

// ─── Main export ──────────────────────────────────────────────────────────────

interface ParsedScoring {
  score: number;
  reason: string;
  tailoredPitch: string;
  skipReason: string | null;
  skipCategory: SkipCategory | null;
  salary: RawSalary;
  needsTailoring: boolean;
  tailoringSuggestions: string | string[] | null;
}

const SKIP_CATEGORIES: readonly SkipCategory[] = ["salary", "seniority", "location", "role_fit", "other"];

function coerceSkipCategory(v: unknown): SkipCategory | null {
  return SKIP_CATEGORIES.includes(v as SkipCategory) ? (v as SkipCategory) : null;
}

/**
 * Call the LLM and parse/validate its JSON, retrying once on a bad response.
 * Returns null only if BOTH attempts produce unparseable or invalid output —
 * the caller turns that into a recorded "skipped" job rather than throwing,
 * so a single bad generation never silently drops a job from the run.
 */
async function completeScoring(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  providerId?: string
): Promise<ParsedScoring | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await chatCompletion(
        messages,
        // max_tokens caps runaway JSON (normal output is ~400-500 tokens).
        // The static system prompt is >1024 tokens, so OpenAI auto-caches it
        // across the run's calls (50-75% off cached input) — keep it byte-stable.
        { temperature: 0.2, response_format: { type: "json_object" }, purpose: "scoring", max_tokens: 900 },
        providerId
      );
      const parsed = parseJsonResponse<Partial<ParsedScoring>>(result.text);

      // Validate the one field we cannot recover from: a missing/NaN score makes
      // every downstream gate meaningless, so treat it as a failed generation.
      const score = Number(parsed.score);
      if (!Number.isFinite(score)) throw new Error("missing or non-numeric score");

      return {
        score,
        reason:        typeof parsed.reason === "string" ? parsed.reason : "",
        tailoredPitch: typeof parsed.tailoredPitch === "string" ? parsed.tailoredPitch : "",
        skipReason:    typeof parsed.skipReason === "string" && parsed.skipReason ? parsed.skipReason : null,
        skipCategory:  coerceSkipCategory(parsed.skipCategory),
        // Coerce a null/absent/non-object salary to {} so normalization treats it
        // as "unknown" instead of throwing.
        salary:        parsed.salary && typeof parsed.salary === "object" ? parsed.salary as RawSalary : {},
        needsTailoring: parsed.needsTailoring === true,
        tailoringSuggestions: parsed.tailoringSuggestions ?? null,
      };
    } catch (err) {
      if (attempt === 1) {
        console.error("[scoreJob] unparseable LLM response after retry:", (err as Error).message);
        return null;
      }
    }
  }
  return null;
}

export async function scoreJob(
  input: ScoringInput,
  providerId?: string
): Promise<ScoringOutput> {
  const parsed = await completeScoring(
    [
      // System = static candidate profile + rubric → cached by OpenAI automatically
      // when the prefix is identical across calls in the same run.
      { role: "system", content: buildSystemPrompt(input) },
      // User = only the dynamic part (company + role + JD).
      { role: "user", content: buildUserPrompt(input) },
    ],
    providerId
  );

  if (!parsed) {
    // Both attempts failed — surface it as a recorded skip (visible in the
    // dashboard with a reason) rather than throwing and vanishing from the run.
    return {
      score: 0,
      reason: "Scoring failed — the model returned an unparseable response twice.",
      tailoredPitch: "",
      skipReason: "scoring_failed",
      skipCategory: "other",
      salary: {},
      needsTailoring: false,
      tailoringSuggestions: null,
    };
  }

  const rawSalary: RawSalary = sanitizeSalary(
    input.sourceSalary?.basis === "stated"
      ? { ...parsed.salary, ...input.sourceSalary }
      : parsed.salary
  );

  const minAnnual  = input.minSalaryAmount ?? config.search.minSalary.amount;
  // normalizeSalary can throw (unsupported currency / FX fetch failure). Swallow to
  // null — matching the sibling call in discover — so a salary hiccup never drops the
  // whole job from the run; salaryGate treats null as "unknown".
  const normalized = await normalizeSalary(rawSalary, input.minSalaryCurrency ?? config.search.minSalary.currency).catch(() => null);
  const gate       = salaryGate(normalized, minAnnual, input.strictSalary ?? config.search.strictSalary);

  let skipReason = parsed.skipReason;
  let skipCategory = parsed.skipCategory;

  // Deterministic relevance-threshold gate. The rubric ASKS the LLM to set
  // skipReason when score < threshold, but a low score with a null skipReason (a
  // common LLM inconsistency) would otherwise sail through as NEW and — because
  // discovery auto-approves + auto-outreaches — DM a stranger. Enforce the
  // threshold in code so it's a real gate, not a prompt suggestion.
  const threshold = input.relevanceThreshold ?? config.search.relevanceThreshold;
  if (!skipReason && parsed.score < threshold) {
    skipReason = `below relevance threshold (${parsed.score} < ${threshold})`;
    // Keep the LLM's category if it gave one; else "other" (a low overall score
    // is a fit problem, not a salary-only skip — don't leak it to friend digests).
    skipCategory = skipCategory ?? "other";
  }

  if (!skipReason && !gate.pass) {
    // LLM passed it but the salary gate (floor + confidence buffer) didn't —
    // by definition a salary-only skip.
    skipReason = gate.reason ?? "salary_below_threshold";
    skipCategory = "salary";
  }
  if (skipReason && !skipCategory) skipCategory = "other";
  if (!skipReason) skipCategory = null;

  return {
    score:          Math.max(0, Math.min(100, Math.round(parsed.score))),
    reason:         parsed.reason,
    tailoredPitch:  sanitizePitch(parsed.tailoredPitch ?? ""),
    skipReason,
    skipCategory,
    salary:         rawSalary,
    salaryFlagReason: gate.reason && gate.pass && gate.reason !== "salary_unknown_kept" ? gate.reason : undefined,
    salaryAnnualBase: normalized?.annualBase,
    needsTailoring:   parsed.needsTailoring === true,
    tailoringSuggestions: parsed.needsTailoring === true ? coerceSuggestions(parsed.tailoringSuggestions) : null,
  };
}
