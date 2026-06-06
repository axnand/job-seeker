/**
 * JSearch source adapter (RapidAPI / OpenWeb Ninja)
 * Aggregates Google for Jobs + LinkedIn, Indeed, Glassdoor, ZipRecruiter in one call.
 * GET https://jsearch.p.rapidapi.com/search
 */

import { config } from "@/config";
import type { RawJob } from "./types";

interface ApplyOption {
  publisher: string;
  apply_link: string;
  is_direct: boolean;
}

interface JSearchJob {
  job_id: string;
  job_title: string;
  employer_name: string;
  job_description: string;
  job_apply_link: string;
  apply_options?: ApplyOption[];
  job_city?: string;
  job_state?: string;
  job_country?: string;
  job_is_remote?: boolean | null;
  work_arrangement?: string;      // "remote" | "hybrid" | "onsite"
  job_posted_at_timestamp?: number;
  job_min_salary?: number;
  job_max_salary?: number;
  job_salary_currency?: string;
  job_salary_period?: string;     // "YEAR" | "MONTH" | "HOUR"
  seniority_level?: string;
  required_technologies?: string[];
}

interface JSearchResponse {
  status: string;
  data: JSearchJob[];
}

function bestApplyLink(job: JSearchJob): string {
  // Prefer a direct apply link over an aggregator redirect
  const direct = job.apply_options?.find(o => o.is_direct);
  return direct?.apply_link ?? job.job_apply_link;
}

function buildLocation(job: JSearchJob): string {
  const isRemote =
    job.job_is_remote === true ||
    job.work_arrangement?.toLowerCase() === "remote";
  if (isRemote) return "Remote";
  const parts = [job.job_city, job.job_state, job.job_country].filter(Boolean);
  return parts.join(", ");
}

function mapPeriod(raw?: string): "year" | "month" | "hour" {
  if (!raw) return "year";
  const p = raw.toUpperCase();
  if (p === "MONTH") return "month";
  if (p === "HOUR")  return "hour";
  return "year";
}

export async function fetchJSearchJobs(keyword: string): Promise<RawJob[]> {
  const { rapidApiKey } = config.jsearch;
  if (!rapidApiKey) return [];

  const url = new URL("https://jsearch.p.rapidapi.com/search");
  url.searchParams.set("query",           `${keyword} in India`);
  url.searchParams.set("page",            "1");
  url.searchParams.set("num_pages",       "1");          // 1 page keeps it under timeout
  url.searchParams.set("date_posted",     config.search.recencyDays <= 1 ? "today" : "3days");
  url.searchParams.set("employment_types","FULLTIME");
  url.searchParams.set("job_requirements","under_3_years_experience,no_experience"); // entry-level

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: {
        "Content-Type":    "application/json",
        "x-rapidapi-host": "jsearch.p.rapidapi.com",
        "x-rapidapi-key":  rapidApiKey,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error("[jsearch] network error:", err);
    return [];
  }

  if (!res.ok) {
    console.error(`[jsearch] API error ${res.status}`);
    return [];
  }

  const data = await res.json() as JSearchResponse;
  if (data.status !== "OK" || !Array.isArray(data.data)) return [];

  return data.data.map(job => ({
    source:        "JSEARCH" as const,
    company:       job.employer_name,
    role:          job.job_title,
    jdText:        job.job_description,
    applyUrl:      bestApplyLink(job),
    location:      buildLocation(job),
    jobProviderId: job.job_id,
    applyType:     "REFERRAL_FIRST" as const,
    postedAt:      job.job_posted_at_timestamp
                     ? new Date(job.job_posted_at_timestamp * 1000)
                     : undefined,
    sourceSalary:  job.job_min_salary
      ? {
          min:        job.job_min_salary,
          max:        job.job_max_salary ?? job.job_min_salary,
          currency:   job.job_salary_currency ?? "USD",
          period:     mapPeriod(job.job_salary_period),
          basis:      "stated" as const,
          confidence: "high" as const,
        }
      : undefined,
  }));
}
