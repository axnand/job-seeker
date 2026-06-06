import type { RawJob } from "./types";

interface RemoteOKJob {
  id: string;
  position: string;
  company: string;
  description?: string;
  url: string;
  location?: string;
  salary_min?: number;
  salary_max?: number;
  date?: string;
}

export async function fetchRemoteOKJobs(keyword: string): Promise<RawJob[]> {
  // RemoteOK requires a User-Agent and their legal terms require attribution
  const res = await fetch(`https://remoteok.com/api?tag=${encodeURIComponent(keyword)}`, {
    headers: { "User-Agent": "job-seeker-personal-tool/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];

  const data = await res.json() as RemoteOKJob[];
  // First item is a legal notice object, skip it
  const jobs = Array.isArray(data) ? data.slice(1) : [];

  return jobs.map(job => ({
    source: "REMOTEOK" as const,
    company: job.company,
    role: job.position,
    jdText: stripHtml(job.description ?? ""),
    applyUrl: job.url,
    location: job.location,
    jobProviderId: job.id,
    applyType: "REFERRAL_FIRST" as const,
    postedAt: job.date ? new Date(job.date) : undefined,
    sourceSalary:
      job.salary_min
        ? {
            min: job.salary_min,
            max: job.salary_max,
            currency: "USD",
            period: "year" as const,
            basis: "stated" as const,
            confidence: "high" as const,
          }
        : undefined,
  }));
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
