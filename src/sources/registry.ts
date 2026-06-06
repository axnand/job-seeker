/**
 * Runs all enabled source adapters, dedupes, and returns fresh RawJobs ready
 * for scoring. Called from /api/cron/discover.
 */

import { getSettings } from "@/lib/settings";
import { fetchLinkedinJobs } from "./linkedin";
import { fetchLinkedinPosts } from "./linkedin-posts";
import { fetchAdzunaJobs } from "./adzuna";
import { fetchAtsWatchlist } from "./ats-watchlist";
import { fetchRemotiveJobs } from "./remotive";
import { fetchRemoteOKJobs } from "./remoteok";
import { fetchJSearchJobs } from "./jsearch";
import { dedupeJobs } from "./dedupe";
import type { RawJob } from "./types";

export async function discoverJobs(): Promise<RawJob[]> {
  const settings = await getSettings();
  const keywords = settings.search.keywords;
  const sources  = settings.sources;
  const search   = settings.search;

  const fetches: Promise<RawJob[]>[] = [];

  if (sources.linkedin) {
    fetches.push(
      ...keywords.map(kw => fetchLinkedinJobs(kw, search).catch(() => [] as RawJob[]))
    );
  }

  if (sources.linkedinPosts) {
    fetches.push(
      ...keywords.map(kw => fetchLinkedinPosts(kw, search).catch(() => [] as RawJob[]))
    );
  }

  if (sources.adzuna) {
    fetches.push(
      ...keywords.map(kw => fetchAdzunaJobs(kw, search).catch(() => [] as RawJob[]))
    );
  }

  if (sources.atsWatchlist) {
    fetches.push(fetchAtsWatchlist(settings.targetCompanies).catch(() => [] as RawJob[]));
  }

  if (sources.remotive) {
    fetches.push(
      ...keywords.map(kw => fetchRemotiveJobs(kw).catch(() => [] as RawJob[]))
    );
  }

  if (sources.remoteok) {
    // RemoteOK accepts one tag at a time; use first keyword only to avoid spam
    fetches.push(fetchRemoteOKJobs(keywords[0] ?? "engineering").catch(() => [] as RawJob[]));
  }

  if (sources.jsearch) {
    fetches.push(
      ...keywords.map(kw => fetchJSearchJobs(kw, search).catch(() => [] as RawJob[]))
    );
  }

  const results = await Promise.allSettled(fetches);
  const allJobs = results.flatMap(r => (r.status === "fulfilled" ? r.value : []));

  console.log(`[discover] raw jobs fetched: ${allJobs.length}`);

  const fresh = await dedupeJobs(allJobs);
  console.log(`[discover] after dedup: ${fresh.length}`);

  return fresh;
}
