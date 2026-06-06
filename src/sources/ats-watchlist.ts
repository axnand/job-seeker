/**
 * Target-company ATS watchlist.
 * Polls public Greenhouse / Lever / Ashby APIs — no scraping, full JD included.
 */

import { config } from "@/config";
import type { RawJob } from "./types";

// ─── Greenhouse ───────────────────────────────────────────────────────────────

interface GreenhouseJob {
  id: number;
  title: string;
  content: string;
  absolute_url: string;
  location: { name: string };
  updated_at: string;
}

async function fetchGreenhouse(company: string, boardToken: string): Promise<RawJob[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs?content=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  const data = await res.json() as { jobs: GreenhouseJob[] };
  return (data.jobs ?? []).map(job => ({
    source: "ATS_WATCHLIST" as const,
    company,
    role: job.title,
    jdText: stripHtml(job.content),
    applyUrl: job.absolute_url,
    location: job.location?.name,
    jobProviderId: String(job.id),
    applyType: "REFERRAL_FIRST" as const,
    postedAt: job.updated_at ? new Date(job.updated_at) : undefined,
  }));
}

// ─── Lever ────────────────────────────────────────────────────────────────────

interface LeverJob {
  id: string;
  text: string;
  descriptionPlain: string;
  hostedUrl: string;
  categories: { location?: string };
  createdAt: number;
}

async function fetchLever(company: string, boardToken: string): Promise<RawJob[]> {
  const url = `https://api.lever.co/v0/postings/${boardToken}?mode=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  const data = await res.json() as LeverJob[];
  return (Array.isArray(data) ? data : []).map(job => ({
    source: "ATS_WATCHLIST" as const,
    company,
    role: job.text,
    jdText: job.descriptionPlain ?? "",
    applyUrl: job.hostedUrl,
    location: job.categories?.location,
    jobProviderId: job.id,
    applyType: "REFERRAL_FIRST" as const,
    postedAt: job.createdAt ? new Date(job.createdAt) : undefined,
  }));
}

// ─── Ashby ────────────────────────────────────────────────────────────────────

interface AshbyJob {
  id: string;
  title: string;
  descriptionSocial?: string;
  jobUrl: string;
  location?: string;
  publishedDate?: string;
}

async function fetchAshby(company: string, boardToken: string): Promise<RawJob[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${boardToken}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  const data = await res.json() as { jobPostings: AshbyJob[] };
  return (data.jobPostings ?? []).map(job => ({
    source: "ATS_WATCHLIST" as const,
    company,
    role: job.title,
    jdText: job.descriptionSocial ?? "",
    applyUrl: job.jobUrl,
    location: job.location,
    jobProviderId: job.id,
    applyType: "REFERRAL_FIRST" as const,
    postedAt: job.publishedDate ? new Date(job.publishedDate) : undefined,
  }));
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export async function fetchAtsWatchlist(): Promise<RawJob[]> {
  const results = await Promise.allSettled(
    config.targetCompanies.map(({ name, ats, boardToken }) => {
      if (ats === "greenhouse") return fetchGreenhouse(name, boardToken);
      if (ats === "lever") return fetchLever(name, boardToken);
      if (ats === "ashby") return fetchAshby(name, boardToken);
      return Promise.resolve([]);
    })
  );

  return results.flatMap(r => (r.status === "fulfilled" ? r.value : []));
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
