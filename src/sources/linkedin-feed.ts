/**
 * LinkedIn feed-watchlist source.
 *
 * LinkedIn exposes NO home-timeline/feed endpoint (verified across the Unipile
 * SDK + OpenAPI index), so the "watch my feed for hiring posts" need is met by
 * curating a small set of authors (recruiters, founders you follow) and polling
 * each one's recent posts. The author is only the SIGNAL — they surfaced the
 * opening. Referral targets are people at the hiring COMPANY (the normal
 * recruiter + peer search), NOT the post author, so we deliberately leave
 * sourcePostAuthorUrl unset and let people-finder fan out to the company.
 *
 * Pipeline mirrors linkedin-posts.ts (and reuses its helpers):
 *   1. GET /users/{publicId}/posts  (newest-first).
 *   2. Drop posts older than recencyDays (client-side; the endpoint has no date filter).
 *   3. Keyword hiring-signal pre-filter — free, no LLM.
 *   4. AI extraction on survivors → RawJob.
 *   5. Follow the apply link → resolve the requisition/job ID for the DM.
 */

import { listUserPosts } from "@/unipile/client";
import { config } from "@/config";
import type { AppSettingsData } from "@/lib/settings";
import {
  extractPost,
  hasHiringSignal,
  postText,
  type LinkedinPostItem,
  type Extraction,
} from "./linkedin-posts";
import { filterUnprocessed, markProcessed } from "./seen-posts";
import { resolveJobId } from "./job-id";
import type { RawJob } from "./types";

type SearchCfg = AppSettingsData["search"];

/** A curated author to monitor. `publicId` is the LinkedIn /in/ slug. */
export interface FeedAuthor {
  name: string;
  publicId: string;
}

const MAX_POSTS_PER_AUTHOR = 10;   // cap LLM extraction cost per author

function postUrl(p: LinkedinPostItem): string | undefined {
  return p.share_url ?? p.post_url ?? p.url;
}

// Posts usually carry the real apply link in the body (often a lnkd.in shortlink
// that resolves on click). The LLM extracts it when it can; this is the fallback
// when it doesn't — pull the first URL out of the post text, ignoring the post's
// own permalink.
function firstUrlInText(text: string, exclude?: string): string | undefined {
  const matches = text.match(/https?:\/\/[^\s)\]<>"']+/gi);
  if (!matches) return undefined;
  return matches.find((u) => u !== exclude);
}

function postedAt(p: LinkedinPostItem): Date | undefined {
  const raw = p.date ?? p.posted_at;
  if (!raw) return undefined;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d;
}

function isRecent(p: LinkedinPostItem, recencyDays: number): boolean {
  const d = postedAt(p);
  if (!d) return true; // no parseable date → keep; dedup guards re-processing
  const cutoff = Date.now() - recencyDays * 24 * 60 * 60 * 1000;
  return d.getTime() >= cutoff;
}

/**
 * Build a RawJob from a watchlist author's post. The author is NOT the target —
 * we route REFERRAL_FIRST and let people-finder search the hiring company (so we
 * leave sourcePostAuthorUrl unset, which is the dm_author short-circuit trigger).
 */
function toRawJob(p: LinkedinPostItem, ex: Extraction): RawJob | null {
  if (!ex.isJobPost) return null;
  const pUrl = postUrl(p);
  const jd = [ex.extractedJd, ex.requirements].filter(Boolean).join("\n\n") || postText(p).slice(0, 2000);

  // The real apply link, for the job ID lookup + direct-apply fallback:
  // LLM-extracted → first URL in the body → post permalink.
  const applyUrl = ex.applyUrl ?? firstUrlInText(postText(p), pUrl) ?? pUrl ?? "https://www.linkedin.com";

  return {
    source: "LINKEDIN_POST",
    company: ex.company ?? "Unknown (LinkedIn post)",
    role: ex.role ?? "Role from LinkedIn post",
    jdText: jd,
    applyUrl,
    jobProviderId: p.id,
    sourcePostUrl: pUrl,
    // Referral targets come from a company people-search, not the post author.
    applyType: "REFERRAL_FIRST",
    postedAt: postedAt(p),
  };
}

async function fetchAuthorPosts(author: FeedAuthor, search: SearchCfg): Promise<RawJob[]> {
  const accountId = config.owner.linkedinAccountId;
  if (!accountId || !author.publicId) return [];

  let items: LinkedinPostItem[] = [];
  try {
    const res = await listUserPosts<LinkedinPostItem>(accountId, author.publicId, MAX_POSTS_PER_AUTHOR);
    items = res.items ?? [];
  } catch (err) {
    console.error(`[linkedin-feed] posts fetch failed for "${author.publicId}":`, err);
    return [];
  }

  let candidates = items
    .filter((p) => isRecent(p, search.recencyDays))
    .filter((p) => hasHiringSignal(postText(p)));
  if (candidates.length === 0) return [];

  // Skip posts we've already run through extraction in a previous tick — the
  // newest-N endpoint keeps returning them while they're recent. Posts without
  // an id can't be deduped, so we always (re)process them.
  const withId = candidates.filter((p) => p.id);
  const unprocessedIds = new Set(await filterUnprocessed(withId.map((p) => p.id!)));
  candidates = candidates.filter((p) => !p.id || unprocessedIds.has(p.id));
  if (candidates.length === 0) return [];

  const extracted = await Promise.allSettled(
    candidates.map(async (p) => {
      const ex = await extractPost(postText(p));
      const job = ex ? toRawJob(p, ex) : null;
      // Follow the apply link to grab the requisition ID for the referral DM, and
      // canonicalize the apply URL (resolves lnkd.in shortlinks to the real ATS).
      if (job) {
        const resolved = await resolveJobId(job.applyUrl);
        if (resolved) {
          job.externalJobId = resolved.jobId ?? undefined;
          job.applyUrl = resolved.resolvedUrl;
        }
      }
      // ex === null means a transient extraction failure — leave it unmarked so
      // the next run retries it. A definitive result (job or not) gets marked.
      return { id: p.id, marked: ex !== null, job };
    })
  );

  const settled = extracted
    .filter((r): r is PromiseFulfilledResult<{ id: string | undefined; marked: boolean; job: RawJob | null }> => r.status === "fulfilled")
    .map((r) => r.value);

  await markProcessed(settled.filter((r) => r.marked && r.id).map((r) => r.id!));

  return settled.map((r) => r.job).filter((j): j is RawJob => j !== null);
}

/** Poll every watchlisted author's recent posts for hiring signals. */
export async function fetchFeedPosts(authors: FeedAuthor[], search: SearchCfg): Promise<RawJob[]> {
  if (!authors.length) return [];
  const results = await Promise.allSettled(authors.map((a) => fetchAuthorPosts(a, search)));
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
