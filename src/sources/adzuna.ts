/**
 * Adzuna job search — India endpoint.
 * GET https://api.adzuna.com/v1/api/jobs/in/search/{page}
 */

import { config } from "@/config";
import type { AppSettingsData } from "@/lib/settings";
import type { RawJob } from "./types";

type SearchCfg = AppSettingsData["search"];

interface AdzunaJob {
  id: string;
  title: string;
  company: { display_name: string };
  description: string;
  redirect_url: string;
  location: { display_name: string };
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string; // "1" when Adzuna estimated it (not employer-stated)
  created: string; // ISO date
}

interface AdzunaResponse {
  results: AdzunaJob[];
}

export async function fetchAdzunaJobs(keyword: string, search: SearchCfg): Promise<RawJob[]> {
  const { appId, appKey } = config.adzuna;
  if (!appId || !appKey) return [];

  const jobs: RawJob[] = [];

  for (let page = 1; page <= 3; page++) {
    const url = new URL(`https://api.adzuna.com/v1/api/jobs/in/search/${page}`);
    url.searchParams.set("app_id", appId);
    url.searchParams.set("app_key", appKey);
    url.searchParams.set("what", keyword);
    url.searchParams.set("where", search.location);
    url.searchParams.set("results_per_page", "50");
    url.searchParams.set("max_days_old", String(search.recencyDays)); // only recent postings
    url.searchParams.set("sort_by", "date");
    url.searchParams.set("content-type", "application/json");
    // NOTE: no salary_min filter. The old `minSalaryAmount / 12` ("monthly") was
    // wrong — Adzuna India salaries are ANNUAL — and filtering at the source by the
    // owner's floor would also drop below-floor roles the friend digest wants
    // (skipCategory "salary"). Salary is judged downstream by the scorer + salaryGate.

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
                // Adzuna often PREDICTS salary (salary_is_predicted="1") rather than
                // quoting the employer. A predicted figure must NOT be trusted as a
                // stated one — mark it estimated/low so salaryGate applies its
                // confidence buffer and scoreJob doesn't override the LLM estimate.
                basis: item.salary_is_predicted === "1" ? "estimated" : "stated",
                confidence: item.salary_is_predicted === "1" ? "low" : "high",
              }
            : undefined,
      });
    }
  }

  return jobs;
}
