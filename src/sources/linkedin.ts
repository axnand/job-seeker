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
import type { RawJob } from "./types";

interface LinkedinJobItem {
  id: string;
  title: string;
  location?: string;
  url?: string;
  company?: { name?: string };
  posted_at?: string;
  easy_apply?: boolean;
}

let cachedRegionId: string | null | undefined;

async function regionId(): Promise<string | null> {
  if (cachedRegionId !== undefined) return cachedRegionId;
  try {
    const items = await resolveSearchParam(config.owner.linkedinAccountId, "LOCATION", "India");
    cachedRegionId = items[0]?.id ?? null;
  } catch {
    cachedRegionId = null;
  }
  return cachedRegionId;
}

const MAX_DETAILS_PER_KEYWORD = 8; // cap detail fetches (each is an API call)

export async function fetchLinkedinJobs(keyword: string): Promise<RawJob[]> {
  const accountId = config.owner.linkedinAccountId;
  if (!accountId) return [];

  const region = await regionId();

  const params: Record<string, unknown> = {
    api: "classic",
    category: "jobs",
    keywords: keyword,
    seniority: [...config.search.linkedinSeniority],
    job_type: [...config.search.linkedinJobType],
    date_posted: config.search.linkedinDatePostedDays,
    sort_by: "date",
  };
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
    top.map(async (item) => {
      const detail = await getJobDetail(accountId, item.id).catch(() => null);
      const company = item.company?.name ?? detail?.company ?? "Unknown";
      const job: RawJob = {
        source: "LINKEDIN_JOB",
        company,
        role: item.title,
        jdText: detail?.description ?? item.title,
        applyUrl: detail?.apply_url ?? item.url ?? `https://www.linkedin.com/jobs/view/${item.id}`,
        location: item.location,
        jobProviderId: item.id,
        applyType: "REFERRAL_FIRST",
        postedAt: item.posted_at ? new Date(item.posted_at) : undefined,
      };
      return job;
    })
  );

  return detailed
    .filter((r): r is PromiseFulfilledResult<RawJob> => r.status === "fulfilled")
    .map(r => r.value);
}
