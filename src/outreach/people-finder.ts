/**
 * People finder — pick 1–2 outreach targets for a job.
 *
 * Priority order:
 *   1. linkedin_post with a known author  → the author IS the target (dm_author)
 *   2. the job's LinkedIn hiring_team       → highest signal (they own the req)
 *   3. people search by company + role      → recruiters/talent first, then peers
 *
 * Every candidate is deduped by LinkedIn provider_id AND against the global
 * Contact cooldown (recontactCooldownDays) — one human is one Contact, never
 * re-contacted within the cooldown across jobs (design §19 #2).
 */

import type { Job } from "@prisma/client";
import {
  getJobDetail,
  searchPeople,
  fetchProfile,
  resolveSearchParam,
  type LinkedinPersonItem,
} from "@/unipile/client";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { getCachedCompanyId, setCachedCompanyId } from "@/lib/id-cache";
import { config } from "@/config";

export interface OutreachTarget {
  providerId: string;
  name: string;
  title?: string;
  company?: string;
  linkedinUrl: string;
  role: "REFERRAL" | "RECRUITER";
}

const RECRUITER_HINT = /\b(recruit|talent|hr\b|people ops|sourcer|staffing|hiring)\b/i;

// Intent keywords for the recruiter/talent search pass (independent of the role).
const RECRUITER_KEYWORDS = "recruiter talent acquisition";

// Seniority / employment-type / noise tokens that shouldn't drive a peer search —
// we want people in the FUNCTION, regardless of level.
const ROLE_NOISE =
  /\b(senior|sr|staff|principal|lead|junior|jr|associate|intern|trainee|grad|graduate|new\s*grad|entry[- ]?level|mid[- ]?senior|i{1,3}|iv|v|1|2|3|remote|hybrid|on[- ]?site|full[- ]?time|part[- ]?time|contract|permanent|freelance)\b/g;

/**
 * Turn a job title into a clean function keyword for people search.
 *   "Senior Java Backend Developer (Remote)" → "java backend developer"
 *   "SDE II"                                  → "software engineer"
 * Falls back to "software engineer" when nothing meaningful survives.
 */
export function roleKeywords(role: string): string {
  const cleaned = (role ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")          // strip parentheticals
    .replace(/\bsdet\b/g, "software engineer in test")
    .replace(/\bsde\b/g, "software engineer")
    .replace(/[-–—|/,;_]+/g, " ")
    .replace(ROLE_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "software engineer";
}

function extractPublicId(url?: string): string | null {
  if (!url) return null;
  try {
    const m = new URL(url).pathname.match(/\/in\/([^/?]+)/);
    return m?.[1]?.replace(/\/$/, "") ?? null;
  } catch {
    return null;
  }
}

function classifyRole(headline?: string): "REFERRAL" | "RECRUITER" {
  return headline && RECRUITER_HINT.test(headline) ? "RECRUITER" : "REFERRAL";
}

function personToTarget(p: LinkedinPersonItem): OutreachTarget | null {
  const providerId = p.provider_id ?? p.id;
  if (!providerId) return null;

  const name = (p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" ") ?? "").trim();

  // Anonymized / out-of-network search results — shown as "LinkedIn Member" with
  // no public handle — carry an ephemeral provider_id that LinkedIn won't let us
  // invite (/users/invite → "Invalid parameters" / "Recipient cannot be reached",
  // profile fetch → 422). Drop them at discovery so we never enqueue a thread
  // that can only burn the circuit breaker and waste an invite slot.
  const hasHandle = !!p.public_identifier || !!p.profile_url;
  if (!hasHandle || !name || /^linkedin member$/i.test(name)) {
    return null;
  }

  const linkedinUrl =
    p.profile_url ??
    (p.public_identifier ? `https://www.linkedin.com/in/${p.public_identifier}` : "https://www.linkedin.com");
  return {
    providerId,
    name,
    title: p.headline,
    company: p.current_company,
    linkedinUrl,
    role: classifyRole(p.headline),
  };
}

/** dm_author / comment posts: the post author is the target — no search needed. */
async function targetFromPostAuthor(job: Job, accountId: string): Promise<OutreachTarget | null> {
  const pubId = extractPublicId(job.sourcePostAuthorUrl ?? undefined);
  if (!pubId) return null;
  try {
    const profile = await fetchProfile(accountId, pubId);
    if (!profile.provider_id) return null;
    return {
      providerId: profile.provider_id,
      name: profile.name ?? [profile.first_name, profile.last_name].filter(Boolean).join(" ") ?? job.sourcePostAuthorName ?? "there",
      title: profile.headline,
      company: job.company,
      linkedinUrl: profile.profile_url ?? job.sourcePostAuthorUrl ?? "https://www.linkedin.com",
      role: "REFERRAL",
    };
  } catch (err) {
    console.warn(`[people-finder] post-author profile fetch failed for job ${job.id}:`, err);
    return null;
  }
}

/** The LinkedIn hiring_team attached to the job posting. Highest-signal targets. */
async function targetsFromHiringTeam(job: Job, accountId: string): Promise<OutreachTarget[]> {
  if (job.source !== "LINKEDIN_JOB" || !job.jobProviderId) return [];
  try {
    const detail = await getJobDetail(accountId, job.jobProviderId);
    const team = detail.hiring_team ?? [];
    const out: OutreachTarget[] = [];
    for (const member of team) {
      let providerId = member.provider_id;
      const pubId = extractPublicId(member.profile_url);
      if (!providerId && pubId) {
        const profile = await fetchProfile(accountId, pubId).catch(() => null);
        providerId = profile?.provider_id;
      }
      if (!providerId) continue;
      out.push({
        providerId,
        name: member.name ?? "there",
        title: member.headline,
        company: job.company,
        linkedinUrl: member.profile_url ?? `https://www.linkedin.com/in/${pubId ?? ""}`,
        role: classifyRole(member.headline),
      });
    }
    return out;
  } catch (err) {
    console.warn(`[people-finder] hiring_team fetch failed for job ${job.id}:`, err);
    return [];
  }
}

/** Strip legal/descriptive suffixes so the name resolves to a LinkedIn company. */
function cleanCompany(name: string): string {
  return name
    .replace(/[.,]/g, " ")
    .replace(/\b(private limited|pvt\.? ?ltd\.?|p\.?ltd|limited|ltd\.?|llc|inc\.?|incorporated|co\.?|corp\.?|corporation|gmbh|s\.?a\.?|technologies|technology|solutions|systems|global services|services)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The distinctive brand token used to hard-filter people to this company. */
function brandToken(name: string): string {
  const cleaned = cleanCompany(name) || name;
  return (cleaned.split(/\s+/)[0] ?? "").toLowerCase();
}

/** Does a person actually look like they work at the target company? */
function matchesCompany(p: OutreachTarget, token: string): boolean {
  if (!token || token.length < 3) return false;
  // Inverted logic: only REJECT when current_company is explicitly set to a company
  // that doesn't match our token — that's LinkedIn filter leakage.
  // If current_company is null (very common in search results), trust the
  // company-scoped search and accept the result.
  if (p.company && !p.company.toLowerCase().includes(token)) return false;
  return true;
}

/**
 * People search scoped to the target company. Runs TWO passes and merges them:
 *   • recruiter pass — talent/recruiting people who own the req
 *   • peer pass      — people in the actual role (from job.role) who can refer
 * Neither is the old literal "software engineer recruiter": a recruiter's
 * headline rarely contains the role, and a peer's rarely contains "recruiter",
 * so a single query missed both. We classify (RECRUITER vs REFERRAL) afterwards.
 *
 * LinkedIn's company filter is soft (it leaks people from other companies), so we
 * ALWAYS hard-filter results by the company brand token. If nothing matches,
 * return [] — never DM random people.
 */
async function targetsFromSearch(job: Job, accountId: string): Promise<OutreachTarget[]> {
  try {
    const token = brandToken(job.company);
    const cleanedName = cleanCompany(job.company);

    // DB-cached company ID (7-day TTL) — avoids one Unipile API call per approval.
    let companyId = await getCachedCompanyId(cleanedName).catch(() => null);
    if (!companyId) {
      const resolved = await resolveSearchParam(accountId, "COMPANY", cleanedName).catch(() => []);
      companyId = resolved[0]?.id ?? null;

      // Fallback: if the full cleaned name didn't resolve (e.g. "SuperPe Marketplace"
      // isn't in LinkedIn's index but "SuperPe" is), retry with just the brand token.
      if (!companyId && token.length >= 4) {
        const fallback = await resolveSearchParam(accountId, "COMPANY", token).catch(() => []);
        companyId = fallback[0]?.id ?? null;
        if (companyId) {
          console.log(`[people-finder] resolved "${job.company}" via brand token "${token}" → ${companyId}`);
        }
      }

      if (companyId) await setCachedCompanyId(cleanedName, companyId).catch(() => {});
    }

    if (!companyId) {
      console.log(`[people-finder] could not resolve company "${job.company}" — skipping search`);
      return [];
    }

    const peerKeywords = roleKeywords(job.role);
    const [recruiters, peers] = await Promise.all([
      searchPeople(accountId, { keywords: RECRUITER_KEYWORDS, companyId, limit: 40 }).catch(() => []),
      searchPeople(accountId, { keywords: peerKeywords, companyId, limit: 40 }).catch(() => []),
    ]);

    const targets = [...recruiters, ...peers]
      .map(personToTarget)
      .filter((t): t is OutreachTarget => t !== null);

    // Hard relevance gate: keep only people whose headline/company mentions the brand.
    const relevant = targets.filter((t) => matchesCompany(t, token));
    console.log(`[people-finder] "${job.company}": ${recruiters.length} recruiters + ${peers.length} peers → ${targets.length} valid → ${relevant.length} matched token "${token}"`);
    if (relevant.length === 0) {
      console.log(`[people-finder] no people matched company "${job.company}" (token "${token}", role "${peerKeywords}") — skipping`);
    }
    return relevant;
  } catch (err) {
    console.warn(`[people-finder] people search failed for job ${job.id}:`, err);
    return [];
  }
}

export interface FindTargetsOpts {
  /** Provider ids to exclude (e.g. people already targeted for this job). */
  exclude?: Set<string>;
  /** Max targets to return. Defaults to maxReferralTargetsPerJob. */
  max?: number;
}

/**
 * Returns up to `max` (default maxReferralTargetsPerJob) targets for this job,
 * deduped against the Contact cooldown and any `exclude` set. Recruiters are
 * prioritized over peers.
 *
 * For post-sourced jobs the author IS the target — we never fan out to random
 * company people, so an excluded/used author yields [] (no replenishment).
 */
export async function findTargets(job: Job, opts: FindTargetsOpts = {}): Promise<OutreachTarget[]> {
  const accountId = config.owner.linkedinAccountId;
  if (!accountId) {
    console.warn("[people-finder] no OWNER_LINKEDIN_ACCOUNT_ID configured — cannot find targets");
    return [];
  }

  const settings = await getSettings();
  const max = opts.max ?? settings.outreach.maxReferralTargetsPerJob;
  const cooldownDays = settings.outreach.recontactCooldownDays;
  const exclude = opts.exclude ?? new Set<string>();
  if (max <= 0) return [];

  // 1. dm_author short-circuit — the author is the only target for a post job.
  if (job.sourcePostAuthorUrl) {
    const author = await targetFromPostAuthor(job, accountId);
    if (author && !exclude.has(author.providerId)) {
      return dedupeAndFilter([author], cooldownDays, max, exclude);
    }
    return [];
  }

  // 2 + 3. hiring team, then search — gather a pool, prioritize recruiters
  const [team, searched] = await Promise.all([
    targetsFromHiringTeam(job, accountId),
    targetsFromSearch(job, accountId),
  ]);

  const pool = [...team, ...searched];
  // Stable sort: recruiters first (they can move the req fastest), then referrals.
  pool.sort((a, b) => (a.role === "RECRUITER" ? 0 : 1) - (b.role === "RECRUITER" ? 0 : 1));

  return dedupeAndFilter(pool, cooldownDays, max, exclude);
}

async function dedupeAndFilter(
  pool: OutreachTarget[],
  cooldownDays: number,
  maxTargets: number,
  exclude: Set<string> = new Set<string>()
): Promise<OutreachTarget[]> {
  // Dedupe within the pool by providerId, dropping anything in `exclude`.
  const seen = new Set<string>();
  const unique = pool.filter((t) => {
    if (!t.providerId || seen.has(t.providerId) || exclude.has(t.providerId)) return false;
    seen.add(t.providerId);
    return true;
  });
  if (unique.length === 0) return [];

  // Dedup against the global Contact cooldown
  const cooldownCutoff = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000);
  const existing = await prisma.contact.findMany({
    where: { linkedinProviderId: { in: unique.map((t) => t.providerId) } },
    select: { linkedinProviderId: true, lastContactedAt: true },
  });
  const recentlyContacted = new Set(
    existing
      .filter((c) => c.lastContactedAt && c.lastContactedAt > cooldownCutoff)
      .map((c) => c.linkedinProviderId)
  );

  return unique.filter((t) => !recentlyContacted.has(t.providerId)).slice(0, maxTargets);
}
