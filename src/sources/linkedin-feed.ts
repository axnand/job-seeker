/**
 * LinkedIn feed-watchlist source.
 *
 * LinkedIn exposes NO home-timeline/feed endpoint (verified across the Unipile
 * SDK + OpenAPI index), so the "watch my feed for hiring posts" need is met by
 * curating a small set of authors (recruiters, founders you follow) and polling
 * each one's recent posts. The author you chose to watch IS the warm outreach
 * target, so every job routes REFERRAL_FIRST with the author pre-attached
 * (people-finder short-circuits on sourcePostAuthorUrl).
 *
 * Pipeline mirrors linkedin-posts.ts (and reuses its helpers):
 *   1. GET /users/{publicId}/posts  (newest-first).
 *   2. Drop posts older than recencyDays (client-side; the endpoint has no date filter).
 *   3. Keyword hiring-signal pre-filter — free, no LLM.
 *   4. AI extraction on survivors → RawJob.
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

/** Build a RawJob from a watchlist author's post — the author is always the target. */
function toRawJob(author: FeedAuthor, p: LinkedinPostItem, ex: Extraction): RawJob | null {
  if (!ex.isJobPost) return null;
  const authorUrl = `https://www.linkedin.com/in/${author.publicId}`;
  const pUrl = postUrl(p);
  const jd = [ex.extractedJd, ex.requirements].filter(Boolean).join("\n\n") || postText(p).slice(0, 2000);

  return {
    source: "LINKEDIN_POST",
    company: ex.company ?? "Unknown (LinkedIn post)",
    role: ex.role ?? "Role from LinkedIn post",
    jdText: jd,
    applyUrl: ex.applyUrl ?? pUrl ?? authorUrl,
    jobProviderId: p.id,
    sourcePostUrl: pUrl,
    // The watchlisted author is the warm referral target, regardless of applyMethod.
    applyType: "REFERRAL_FIRST",
    postedAt: postedAt(p),
    sourcePostAuthorUrl: authorUrl,
    sourcePostAuthorName: author.name,
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

  const candidates = items
    .filter((p) => isRecent(p, search.recencyDays))
    .filter((p) => hasHiringSignal(postText(p)));
  if (candidates.length === 0) return [];

  const extracted = await Promise.allSettled(
    candidates.map(async (p) => {
      const ex = await extractPost(postText(p));
      return ex ? toRawJob(author, p, ex) : null;
    })
  );

  return extracted
    .filter((r): r is PromiseFulfilledResult<RawJob | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((j): j is RawJob => j !== null);
}

/** Poll every watchlisted author's recent posts for hiring signals. */
export async function fetchFeedPosts(authors: FeedAuthor[], search: SearchCfg): Promise<RawJob[]> {
  if (!authors.length) return [];
  const results = await Promise.allSettled(authors.map((a) => fetchAuthorPosts(a, search)));
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
