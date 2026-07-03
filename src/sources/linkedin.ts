/**
 * LinkedIn job-board search via Unipile.
 * POST /api/v1/linkedin/search?account_id=...  { api:"classic", category:"jobs" }
 *
 * Notes (learned from the live API):
 *  - account_id is a QUERY param, not body.
 *  - Use `region` (string location id) NOT `location` (array) — the array form
 *    returns 0 results. The account proxies through India so results are
 *    India-centric by default anyway.
 *  - Search results do NOT include the JD; fetch it per-job via getJobDetail.
 */

import { linkedinSearch, getJobDetail, resolveSearchParam } from "@/unipile/client";
import { config } from "@/config";
import {
  getCachedLocationId,
  setCachedLocationId,
  hasFetchedJobDetail,
  markJobDetailFetched,
} from "@/lib/id-cache";
import type { AppSettingsData } from "@/lib/settings";
import type { RawJob } from "./types";

type SearchCfg = AppSettingsData["search"];

interface LinkedinJobItem {
  id: string;
  title: string;
  location?: string;
  url?: string;
  company?: { name?: string };
  posted_at?: string;
  easy_apply?: boolean;
}

/**
 * Resolve the LinkedIn region ID for a location string.
 * DB-cached (survives Vercel cold starts) — location IDs never change so TTL
 * is effectively permanent. Falls back to null (searches still work without it).
 */
async function regionId(locationText: string): Promise<string | null> {
  const text = locationText || "India";
  const cached = await getCachedLocationId(text).catch(() => null);
  if (cached) return cached;
  try {
    const items = await resolveSearchParam(config.owner.linkedinAccountId, "LOCATION", text);
    const id = items[0]?.id ?? null;
    if (id) await setCachedLocationId(text, id).catch(() => {});
    return id;
  } catch {
    return null;
  }
}

const MAX_DETAILS_PER_KEYWORD = 8; // cap detail fetches (each is an API call)

export async function fetchLinkedinJobs(keyword: string, search: SearchCfg): Promise<RawJob[]> {
  const accountId = config.owner.linkedinAccountId;
  if (!accountId) return [];

  const region = await regionId(search.location);

  const params: Record<string, unknown> = {
    api: "classic",
    category: "jobs",
    keywords: keyword,
    seniority: [...search.linkedinSeniority],
    job_type: [...search.linkedinJobType],
    date_posted: search.recencyDays,   // only recent postings
    sort_by: "date",                    // newest first
  };
  if (search.linkedinPresence?.length) params.presence = [...search.linkedinPresence];
  if (region) params.region = region;

  let items: LinkedinJobItem[] = [];
  try {
    const res = await linkedinSearch<LinkedinJobItem>(
      accountId,
      params as Parameters<typeof linkedinSearch>[1]
    );
    items = res.items ?? [];
  } catch (err) {
    console.error(`[linkedin] search failed for "${keyword}":`, err);
    return [];
  }

  // Fetch JD detail for the top N results (results lack description).
  const top = items.slice(0, MAX_DETAILS_PER_KEYWORD);
  const detailed = await Promise.allSettled(
    top.map(async (item): Promise<RawJob | null> => {
      // getJobDetail is a paid call. Skip ids we already fetched in the last 7
      // days — those jobs were persisted on a prior run and would just be
      // DB-deduped now, so drop the item early instead of paying again.
      if (await hasFetchedJobDetail(item.id).catch(() => false)) return null;

      const detail = await getJobDetail(accountId, item.id).catch(() => null);
      // Only remember ids we actually got detail for, so a transient failure retries.
      if (detail) await markJobDetailFetched(item.id).catch(() => {});

      const company = item.company?.name ?? detail?.company ?? "Unknown";
      const job: RawJob = {
        source: "LINKEDIN_JOB",
        company,
        role: item.title,
        jdText: detail?.description ?? item.title,
        applyUrl: detail?.apply_url ?? item.url ?? `https://www.linkedin.com/jobs/view/${item.id}`,
        location: item.location,
        jobProviderId: item.id,
        companyId: detail?.company_id,
        applyType: "REFERRAL_FIRST",
        postedAt: item.posted_at ? new Date(item.posted_at) : undefined,
      };
      return job;
    })
  );

  return detailed
    .filter((r): r is PromiseFulfilledResult<RawJob | null> => r.status === "fulfilled")
    .map(r => r.value)
    .filter((j): j is RawJob => j !== null);
}
