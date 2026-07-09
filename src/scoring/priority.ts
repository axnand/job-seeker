/**
 * Composite priority score — "which job should I act on TODAY?"
 *
 * A pure function of a single Job row (no extra queries): every input it needs
 * is already cached on the row (aiScore, normalized salary, outreachState,
 * postedAt). Used by the jobs list API (board sort + Apply Today strip) and the
 * daily digest (Top Picks section), so both always agree on the ranking.
 *
 *   fit    40%  aiScore — how well the role matches the profile
 *   pay    25%  salary headroom over the owner's floor (1.0× → 50, 1.5×+ → 100)
 *   trust  10%  how much the salary figure can be believed (stated ≫ low-conf guess)
 *   reach  15%  referral traction — a reply/connection means a warm door TODAY
 *   fresh  10%  posting age — junior req pipelines close fast, act while it's warm
 */

import { config } from "@/config";

export interface PriorityInput {
  aiScore: number | null;
  salaryAnnualBase: number | null;
  salaryBasis: string | null;      // "STATED" | "ESTIMATED"
  salaryConfidence: string | null; // "HIGH" | "MEDIUM" | "LOW"
  outreachState: string;
  postedAt: Date | string | null;
  createdAt: Date | string;
}

export interface PriorityParts {
  fit: number;
  pay: number;
  trust: number;
  reach: number;
  fresh: number;
}

const REACH_SCORE: Record<string, number> = {
  REPLIED: 100,          // someone answered — strongest signal to push today
  MESSAGED: 80,
  CONNECTED: 75,
  INVITE_SENT: 55,
  NONE: 30,              // untouched pool — still fully reachable
  NO_REPLY_ARCHIVED: 10, // pool went cold
};

function payScore(annualBase: number | null, floor: number): number {
  if (!annualBase) return 35; // unknown — neutral-low, don't reward missing data
  const ratio = annualBase / floor;
  if (ratio <= 0.9) return 0;
  if (ratio < 1.0) return ((ratio - 0.9) / 0.1) * 50;           // 0.9–1.0× → 0–50
  return Math.min(100, 50 + ((ratio - 1.0) / 0.5) * 50);        // 1.0–1.5× → 50–100
}

function trustScore(basis: string | null, confidence: string | null): number {
  if ((basis ?? "").toUpperCase() === "STATED") return 100;
  switch ((confidence ?? "").toUpperCase()) {
    case "HIGH":   return 70;
    case "MEDIUM": return 50;
    case "LOW":    return 25;
    default:       return 15;
  }
}

function freshScore(postedAt: Date | string | null, createdAt: Date | string): number {
  const when = new Date(postedAt ?? createdAt).getTime();
  const days = (Date.now() - when) / 86_400_000;
  // Full marks the first 2 days, linear decay to 0 at 3 weeks.
  if (days <= 2) return 100;
  return Math.max(0, 100 - ((days - 2) / 19) * 100);
}

export function computePriority(
  job: PriorityInput,
  // Live-tuned floor from settings.search.minSalaryAmount when the caller has it;
  // falls back to the config default so board/digest ranking matches scoring.
  floor: number = config.search.minSalary.amount,
): { score: number; parts: PriorityParts } {
  const parts: PriorityParts = {
    fit:   job.aiScore ?? 40, // unscored — neutral, shouldn't top the list
    pay:   payScore(job.salaryAnnualBase, floor),
    trust: trustScore(job.salaryBasis, job.salaryConfidence),
    reach: REACH_SCORE[job.outreachState] ?? 30,
    fresh: freshScore(job.postedAt, job.createdAt),
  };
  const score =
    parts.fit   * 0.40 +
    parts.pay   * 0.25 +
    parts.trust * 0.10 +
    parts.reach * 0.15 +
    parts.fresh * 0.10;
  return { score: Math.round(score), parts };
}

/** One-line human explanation for tooltips/digest ("fit 82 · 1.3× floor · stated · connected · 2d"). */
export function priorityWhy(
  job: PriorityInput,
  parts: PriorityParts,
  floor: number = config.search.minSalary.amount,
): string {
  const bits: string[] = [`fit ${job.aiScore ?? "—"}`];
  if (job.salaryAnnualBase) {
    bits.push(`${(job.salaryAnnualBase / floor).toFixed(1)}× floor`);
    bits.push((job.salaryBasis ?? "").toUpperCase() === "STATED" ? "stated" : `est-${(job.salaryConfidence ?? "?").toLowerCase()}`);
  } else {
    bits.push("salary unknown");
  }
  if (job.outreachState !== "NONE") bits.push(job.outreachState.toLowerCase().replace(/_/g, " "));
  const days = Math.floor((Date.now() - new Date(job.postedAt ?? job.createdAt).getTime()) / 86_400_000);
  bits.push(days <= 0 ? "today" : `${days}d`);
  return bits.join(" · ");
}
