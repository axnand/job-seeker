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
 * Confidence-aware margins (low-confidence estimates that barely clear the
 * floor are likely over-estimates, so we require a buffer):
 *   stated / high  → pass at exactly the floor (we trust the number)
 *   medium         → pass at exactly the floor (reasonably reliable)
 *   low            → pass only if estimate is ≥15% above the floor
 *                    (shaky guess: need headroom before burning outreach quota)
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

  const isLowConfidence = salary.confidence === "low" && salary.basis !== "stated";
  const effectiveFloor = isLowConfidence ? minAnnualBase * 1.15 : minAnnualBase;

  if (salary.annualBase >= effectiveFloor) {
    return { pass: true };
  }

  // Below threshold. Drop when we're reasonably sure: stated figure, or
  // medium/high-confidence estimate. Low-confidence below the effective floor
  // is also dropped — it's a shaky guess that doesn't clear even the buffered bar.
  if (salary.basis === "stated" || salary.confidence === "high" || salary.confidence === "medium") {
    return { pass: false, reason: `salary_below_threshold_${salary.basis}` };
  }

  // Low-confidence estimate that cleared the base floor but not the 15% buffer
  if (isLowConfidence) {
    return { pass: false, reason: "salary_low_confidence_below_buffer" };
  }

  // Fallback: uncertain estimate below threshold — keep but flag
  return { pass: true, reason: "salary_uncertain_estimate_flagged" };
}
