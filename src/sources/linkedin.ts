/**
 * LinkedIn job-board search via Unipile.
 * POST /api/v1/linkedin/search  { api:"classic", category:"jobs" }
 *
 * NOTE: LinkedIn search takes IDs for location, industry, etc. — not raw text.
 * resolveLinkedinParams() caches these lookups once per run.
 */

import { linkedinSearch, resolveSearchParam } from "@/unipile/client";
import { config } from "@/config";
import type { RawJob } from "./types";

interface LinkedinJobItem {
  job_id?: string;
  title?: string;
  company_name?: string;
  description?: string;
  apply_url?: string;
  location?: string;
  salary?: { min?: number; max?: number; currency?: string };
  listed_at?: number;
}

let cachedLocationId: string | null = null;

async function resolveLocationId(location: string): Promise<string | null> {
  if (cachedLocationId) return cachedLocationId;
  try {
    const items = await resolveSearchParam(
      config.owner.linkedinAccountId,
      "LOCATION",
      location
    );
    cachedLocationId = items[0]?.id ?? null;
    return cachedLocationId;
  } catch {
    return null;
  }
}

export async function fetchLinkedinJobs(keyword: string): Promise<RawJob[]> {
  const accountId = config.owner.linkedinAccountId;
  if (!accountId) return [];

  const locationId = await resolveLocationId(config.search.location);

  const searchParams: Record<string, unknown> = {
    api: "classic",
    category: "jobs",
    keywords: keyword,
  };
  if (locationId) searchParams.location = [{ id: locationId }];

  const jobs: RawJob[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 3; page++) {
    const res = await linkedinSearch<LinkedinJobItem>(
      accountId,
      searchParams as Parameters<typeof linkedinSearch>[1],
      cursor
    );

    for (const item of res.items) {
      if (!item.title || !item.company_name) continue;
      jobs.push({
        source: "LINKEDIN_JOB",
        company: item.company_name,
        role: item.title,
        jdText: item.description ?? "",
        applyUrl: item.apply_url ?? "",
        location: item.location,
        jobProviderId: item.job_id,
        applyType: "REFERRAL_FIRST",
        postedAt: item.listed_at ? new Date(item.listed_at * 1000) : undefined,
        sourceSalary: item.salary?.min
          ? {
              min: item.salary.min,
              max: item.salary.max,
              currency: item.salary.currency ?? "USD",
              period: "year",
              basis: "stated",
              confidence: "high",
            }
          : undefined,
      });
    }

    if (!res.cursor || res.items.length === 0) break;
    cursor = String(res.cursor);
  }

  return jobs;
}
