import { convertCurrency } from "./fx";
import { config } from "@/config";

export interface RawSalary {
  min?: number | null;
  max?: number | null;
  currency?: string | null;
  period?: "year" | "month" | "hour" | null;
  basis?: "stated" | "estimated" | null;
  confidence?: "high" | "medium" | "low" | null;
}

export interface NormalizedSalary extends Required<Omit<RawSalary, "min" | "max">> {
  min: number;
  max: number;
  annualBase: number; // in config.search.baseCurrency
}

const MONTHS_PER_YEAR = 12;
const HOURS_PER_YEAR = 2080;

function annualize(amount: number, period: "year" | "month" | "hour"): number {
  if (period === "year") return amount;
  if (period === "month") return amount * MONTHS_PER_YEAR;
  return amount * HOURS_PER_YEAR;
}

/**
 * Returns null when salary is entirely unknown (min/max both absent).
 * Always converts to config.search.baseCurrency for comparison.
 */
export async function normalizeSalary(
  raw: RawSalary,
  overrideBaseCurrency?: string
): Promise<NormalizedSalary | null> {
  if (!raw || (!raw.min && !raw.max)) return null;

  const currency = raw.currency ?? config.search.baseCurrency;
  const period = raw.period ?? "year";
  const basis = raw.basis ?? "estimated";
  const confidence = raw.confidence ?? "low";

  const mid = raw.min ?? raw.max!;
  const min = raw.min ?? mid;
  const max = raw.max ?? mid;

  const annualMin = annualize(min, period);
  const annualMax = annualize(max, period);
  const annualMid = (annualMin + annualMax) / 2;

  const baseCurrency = overrideBaseCurrency ?? config.search.baseCurrency;
  const annualBase = await convertCurrency(annualMid, currency, baseCurrency);

  return { min, max, currency, period, basis, confidence, annualBase };
}

export interface SalaryGateResult {
  pass: boolean;
  reason?: string;
}

/**
 * Decide whether a job passes the salary gate.
 *
 * The bug this guards against: an ESTIMATE (a guess from the model's memory) that
 * lands just above the floor is most likely an over-estimate — and an over-estimate
 * that lets a low-paying role through is the worst outcome (it burns outreach quota
 * on a role you'd never take). So estimates must clear the floor by a margin that
 * grows as confidence drops; only a STATED figure is trusted at the bare floor:
 *
 *   basis=stated              → floor × 1.00  (we trust the number)
 *   estimated + high          → floor × 1.10
 *   estimated + medium        → floor × 1.20
 *   estimated + low / unknown → floor × 1.35  (shaky guess: needs real headroom)
 *
 * Anything below its effective floor is dropped — there is no "below floor but
 * keep anyway" path, which is what previously let medium-confidence guesses slip in.
 */
export function salaryGate(
  salary: NormalizedSalary | null,
  minAnnualBase: number,
  strictSalary?: boolean
): SalaryGateResult {
  const strict = strictSalary ?? config.search.strictSalary;
  if (!salary) {
    if (strict) return { pass: false, reason: "salary_unknown_strict_mode" };
    return { pass: true, reason: "salary_unknown_kept" };
  }

  // Margin required above the floor, scaled by how much we trust the figure.
  const buffer =
    salary.basis === "stated"      ? 1.00 :
    salary.confidence === "high"   ? 1.10 :
    salary.confidence === "medium" ? 1.20 :
                                     1.35; // low / unknown estimate — needs real headroom
  const effectiveFloor = minAnnualBase * buffer;

  if (salary.annualBase >= effectiveFloor) return { pass: true };

  return { pass: false, reason: `salary_below_threshold_${salary.basis}_${salary.confidence}` };
}
