/**
 * Runs all enabled source adapters, dedupes, and returns fresh RawJobs ready
 * for scoring. Called from /api/cron/discover.
 */

import { getSettings } from "@/lib/settings";
import { fetchLinkedinJobs } from "./linkedin";
import { fetchLinkedinPosts } from "./linkedin-posts";
import { fetchFeedPosts } from "./linkedin-feed";
import { fetchAdzunaJobs } from "./adzuna";
import { fetchAtsWatchlist } from "./ats-watchlist";
import { fetchRemotiveJobs } from "./remotive";
import { fetchRemoteOKJobs } from "./remoteok";
import { fetchJSearchJobs } from "./jsearch";
import { dedupeJobs } from "./dedupe";
import type { RawJob } from "./types";

/**
 * Run one source's fetch tasks, returning its jobs and logging visibility:
 * a per-source job count, a warning on partial failure, and a LOUD error if
 * every task failed (a sign the source is down or its auth/key expired —
 * previously this just silently returned zero jobs).
 */
async function runSource(label: string, tasks: Promise<RawJob[]>[]): Promise<RawJob[]> {
  const settled = await Promise.allSettled(tasks);
  const failed = settled.filter(s => s.status === "rejected");
  const jobs = settled.flatMap(s => (s.status === "fulfilled" ? s.value : []));

  if (failed.length === settled.length) {
    console.error(
      `[discover] source "${label}": ALL ${settled.length} request(s) FAILED — source likely down or auth/key expired. First error:`,
      (failed[0] as PromiseRejectedResult | undefined)?.reason
    );
  } else if (failed.length > 0) {
    console.warn(`[discover] source "${label}": ${failed.length}/${settled.length} request(s) failed, ${jobs.length} jobs`);
  } else if (jobs.length === 0) {
    console.warn(`[discover] source "${label}": 0 jobs (no failures — just nothing fresh)`);
  } else {
    console.log(`[discover] source "${label}": ${jobs.length} jobs`);
  }
  return jobs;
}

export async function discoverJobs(): Promise<RawJob[]> {
  const settings = await getSettings();
  const keywords = settings.search.keywords;
  const sources  = settings.sources;
  const search   = settings.search;

  // Each source's tasks start eagerly here, so all sources still fetch
  // concurrently; runSource only awaits + reports per-source outcomes.
  const groups: Promise<RawJob[]>[] = [];

  if (sources.linkedin)      groups.push(runSource("linkedin",      keywords.map(kw => fetchLinkedinJobs(kw, search))));
  if (sources.linkedinPosts) groups.push(runSource("linkedinPosts", keywords.map(kw => fetchLinkedinPosts(kw, search))));
  if (sources.linkedinFeed)  groups.push(runSource("linkedinFeed",  [fetchFeedPosts(settings.feedAuthors, search)]));
  if (sources.adzuna)        groups.push(runSource("adzuna",        keywords.map(kw => fetchAdzunaJobs(kw, search))));
  if (sources.atsWatchlist)  groups.push(runSource("atsWatchlist",  [fetchAtsWatchlist(settings.targetCompanies)]));
  if (sources.remotive)      groups.push(runSource("remotive",      keywords.map(kw => fetchRemotiveJobs(kw))));
  // RemoteOK accepts one tag at a time; use first keyword only to avoid spam.
  if (sources.remoteok)      groups.push(runSource("remoteok",      [fetchRemoteOKJobs(keywords[0] ?? "engineering")]));
  if (sources.jsearch)       groups.push(runSource("jsearch",       keywords.map(kw => fetchJSearchJobs(kw, search))));

  const allJobs = (await Promise.all(groups)).flat();
  console.log(`[discover] raw jobs fetched: ${allJobs.length}`);

  const fresh = await dedupeJobs(allJobs, settings.staleness.noNewOutreachAfterDays);
  console.log(`[discover] after dedup: ${fresh.length}`);

  return fresh;
}
