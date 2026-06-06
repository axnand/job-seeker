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
  const name = p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" ") ?? "there";
  const linkedinUrl =
    p.profile_url ??
    (p.public_identifier ? `https://www.linkedin.com/in/${p.public_identifier}` : "https://www.linkedin.com");
  return {
    providerId,
    name: name || "there",
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

/** People search by company + role keywords. */
async function targetsFromSearch(job: Job, accountId: string): Promise<OutreachTarget[]> {
  try {
    const companyMatches = await resolveSearchParam(accountId, "COMPANY", job.company).catch(() => []);
    const companyId = companyMatches[0]?.id;
    // Bias toward people who can actually refer/hire: recruiters + the role's team.
    const keywords = `${job.role} recruiter talent`;
    const people = await searchPeople(accountId, { keywords, companyId, limit: 10 });
    return people.map(personToTarget).filter((t): t is OutreachTarget => t !== null);
  } catch (err) {
    console.warn(`[people-finder] people search failed for job ${job.id}:`, err);
    return [];
  }
}

/**
 * Returns up to maxReferralTargetsPerJob targets for this job, deduped against
 * the Contact cooldown. Recruiters are prioritized over peers.
 */
export async function findTargets(job: Job): Promise<OutreachTarget[]> {
  const accountId = config.owner.linkedinAccountId;
  if (!accountId) {
    console.warn("[people-finder] no OWNER_LINKEDIN_ACCOUNT_ID configured — cannot find targets");
    return [];
  }

  const settings = await getSettings();
  const maxTargets = settings.outreach.maxReferralTargetsPerJob;
  const cooldownDays = settings.outreach.recontactCooldownDays;

  // 1. dm_author short-circuit
  if (job.sourcePostAuthorUrl) {
    const author = await targetFromPostAuthor(job, accountId);
    if (author) return dedupeAndFilter([author], cooldownDays, maxTargets);
  }

  // 2 + 3. hiring team, then search — gather a pool, prioritize recruiters
  const [team, searched] = await Promise.all([
    targetsFromHiringTeam(job, accountId),
    targetsFromSearch(job, accountId),
  ]);

  const pool = [...team, ...searched];
  // Stable sort: recruiters first (they can move the req fastest), then referrals.
  pool.sort((a, b) => (a.role === "RECRUITER" ? 0 : 1) - (b.role === "RECRUITER" ? 0 : 1));

  return dedupeAndFilter(pool, cooldownDays, maxTargets);
}

async function dedupeAndFilter(
  pool: OutreachTarget[],
  cooldownDays: number,
  maxTargets: number
): Promise<OutreachTarget[]> {
  // Dedupe within the pool by providerId
  const seen = new Set<string>();
  const unique = pool.filter((t) => {
    if (!t.providerId || seen.has(t.providerId)) return false;
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
