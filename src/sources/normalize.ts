/**
 * Cross-source dedup key.
 *
 * Problems with a naive key:
 *   - LinkedIn: "Bengaluru, Karnataka, India (Hybrid)"
 *   - Adzuna:   "Bengaluru, India"
 *   → same role at same company, different keys → passes dedup twice → double outreach.
 *
 * Fix:
 *   1. Strip parentheticals: "(Hybrid)", "(On-site)", "(Remote)", "(Contract)" etc.
 *   2. Normalize city aliases: Bangalore ↔ Bengaluru, Bombay ↔ Mumbai, etc.
 *   3. Drop everything after the city (state, country, district) — too noisy.
 *   4. Strip non-alphanumeric and lowercase.
 */

const PARENTHETICAL = /\s*\([^)]*\)/g;

const CITY_ALIASES: [RegExp, string][] = [
  [/\bbengaluru\b/i,   "bangalore"],
  [/\bbangalore\b/i,   "bangalore"],
  [/\bmumbai\b/i,      "mumbai"],
  [/\bbombay\b/i,      "mumbai"],
  [/\bkolkata\b/i,     "kolkata"],
  [/\bcalcutta\b/i,    "kolkata"],
  [/\bdelhi\b/i,       "delhi"],
  [/\bnew delhi\b/i,   "delhi"],
  [/\bhyderabad\b/i,   "hyderabad"],
  [/\bpune\b/i,        "pune"],
  [/\bchennai\b/i,     "chennai"],
  [/\bmadras\b/i,      "chennai"],
  [/\bgurugram\b/i,    "gurgaon"],
  [/\bgurgaon\b/i,     "gurgaon"],
  [/\bnoida\b/i,       "noida"],
];

function normalizeLocation(raw: string): string {
  let s = raw.replace(PARENTHETICAL, "").trim();
  // Take only the first comma-segment (city), drop state/country/district.
  s = s.split(",")[0].trim();
  for (const [pat, canonical] of CITY_ALIASES) {
    s = s.replace(pat, canonical);
  }
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
}

function normalizeText(s: string, maxLen = 40): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, maxLen);
}

export function dedupeKey(company: string, role: string, location?: string): string {
  const c = normalizeText(company);
  const r = normalizeText(role);
  const l = location ? normalizeLocation(location) : "";
  return `${c}::${r}::${l}`;
}

/**
 * Stable grouping key for a company name. Used to (a) merge a company's postings
 * into one board card and (b) pool/dedup contacts across all of that company's
 * roles, so the same person is never cold-contacted twice across roles.
 * Strips the same legal/descriptive suffixes the people-finder strips, so
 * "Visa", "Visa Inc.", and "Visa Technologies" collapse to one key.
 */
const COMPANY_SUFFIXES =
  /\b(private limited|pvt\.? ?ltd\.?|p\.?ltd|limited|ltd\.?|llc|inc\.?|incorporated|co\.?|corp\.?|corporation|gmbh|s\.?a\.?|technologies|technology|solutions|systems|global services|services)\b/gi;

export function companyKey(company: string): string {
  return normalizeText(company.replace(COMPANY_SUFFIXES, " "));
}
