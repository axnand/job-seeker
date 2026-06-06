import type { RawJob } from "./types";

interface RemotiveJob {
  id: number;
  title: string;
  company_name: string;
  description: string;
  url: string;
  candidate_required_location?: string;
  salary?: string;
  publication_date: string;
}

export async function fetchRemotiveJobs(keyword: string): Promise<RawJob[]> {
  const url = new URL("https://remotive.com/api/remote-jobs");
  url.searchParams.set("search", keyword);
  url.searchParams.set("limit", "50");

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];

  const data = await res.json() as { jobs: RemotiveJob[] };
  return (data.jobs ?? []).map(job => ({
    source: "REMOTIVE" as const,
    company: job.company_name,
    role: job.title,
    jdText: stripHtml(job.description),
    applyUrl: job.url,
    location: job.candidate_required_location,
    jobProviderId: String(job.id),
    applyType: "REFERRAL_FIRST" as const,
    postedAt: job.publication_date ? new Date(job.publication_date) : undefined,
  }));
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
