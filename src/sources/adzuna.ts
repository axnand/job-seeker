/**
 * Adzuna job search — India endpoint.
 * GET https://api.adzuna.com/v1/api/jobs/in/search/{page}
 */

import { config } from "@/config";
import type { RawJob } from "./types";

interface AdzunaJob {
  id: string;
  title: string;
  company: { display_name: string };
  description: string;
  redirect_url: string;
  location: { display_name: string };
  salary_min?: number;
  salary_max?: number;
  created: string; // ISO date
}

interface AdzunaResponse {
  results: AdzunaJob[];
}

export async function fetchAdzunaJobs(keyword: string): Promise<RawJob[]> {
  const { appId, appKey } = config.adzuna;
  if (!appId || !appKey) return [];

  const jobs: RawJob[] = [];

  for (let page = 1; page <= 3; page++) {
    const url = new URL(`https://api.adzuna.com/v1/api/jobs/in/search/${page}`);
    url.searchParams.set("app_id", appId);
    url.searchParams.set("app_key", appKey);
    url.searchParams.set("what", keyword);
    url.searchParams.set("where", config.search.location);
    url.searchParams.set("results_per_page", "50");
    url.searchParams.set("content-type", "application/json");
    if (config.search.minSalary.currency === "INR") {
      url.searchParams.set("salary_min", String(config.search.minSalary.amount / 12)); // monthly
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
    } catch {
      break;
    }
    if (!res.ok) break;

    const data = await res.json() as AdzunaResponse;
    if (!data.results?.length) break;

    for (const item of data.results) {
      jobs.push({
        source: "ADZUNA",
        company: item.company.display_name,
        role: item.title,
        jdText: item.description,
        applyUrl: item.redirect_url,
        location: item.location.display_name,
        jobProviderId: item.id,
        applyType: "REFERRAL_FIRST",
        postedAt: item.created ? new Date(item.created) : undefined,
        sourceSalary:
          item.salary_min
            ? {
                min: item.salary_min,
                max: item.salary_max,
                currency: "INR",
                period: "year",
                basis: "stated",
                confidence: "high",
              }
            : undefined,
      });
    }
  }

  return jobs;
}
