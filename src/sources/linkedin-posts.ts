/**
 * LinkedIn hiring-post detection (design §16).
 * POST /api/v1/linkedin/search  { api:"classic", category:"posts" }
 *
 * Pipeline (cheap → expensive):
 *   1. Search recent posts by keyword (native date_posted filter).
 *   2. Keyword pre-filter — drop posts with no hiring signal (free, no LLM).
 *   3. AI extraction on survivors → structured job (one LLM call each).
 *   4. Route by applyMethod → RawJob (same relevance + salary gates downstream).
 *
 * dm_author / comment posts skip the people finder entirely — the post author
 * IS the warm target (people-finder short-circuits on sourcePostAuthorUrl).
 */

import { linkedinSearch } from "@/unipile/client";
import { chatCompletion, parseJsonResponse } from "@/ai/ai-adapter";
import { config } from "@/config";
import type { AppSettingsData } from "@/lib/settings";
import { filterUnprocessed, markProcessed } from "./seen-posts";
import type { RawJob } from "./types";

type SearchCfg = AppSettingsData["search"];

export interface LinkedinPostItem {
  id?: string;
  text?: string;
  content?: string;
  share_url?: string;
  post_url?: string;
  url?: string;
  date?: string;
  posted_at?: string;
  author?: {
    name?: string;
    first_name?: string;
    last_name?: string;
    profile_url?: string;
    public_identifier?: string;
    provider_id?: string;
    headline?: string;
  };
}

// Step 2 — hiring-signal pre-filter (design §16). A post must contain at least
// one of these before we spend an LLM call on it.
const HIRING_SIGNALS = [
  "we're hiring", "we are hiring", "looking for a", "open role", "open position",
  "join our team", "join us", "dm me", "dm your resume", "send me your cv",
  "send your resume", "we're looking for", "now hiring", "hiring for",
  "#hiring", "#opentowork", "actively hiring", "apply now", "job opening",
];

export function hasHiringSignal(text: string): boolean {
  const t = text.toLowerCase();
  return HIRING_SIGNALS.some((s) => t.includes(s));
}

const MAX_POSTS_PER_KEYWORD = 6;       // cap LLM extraction cost per keyword
const EXTRACT_SYSTEM = `You extract structured job data from a LinkedIn post. Many posts are NOT job posts (news, opinions, promotions). Respond with a single JSON object only — no prose.`;

export interface Extraction {
  isJobPost: boolean;
  company: string | null;
  role: string | null;
  requirements: string | null;
  applyMethod: "link" | "dm_author" | "comment" | "unclear";
  applyUrl: string | null;
  extractedJd: string | null;
}

function extractPrompt(postText: string): string {
  return `Decide if this LinkedIn post is a JOB POST (someone hiring for a role). If yes, extract the details.

## Post
${postText.slice(0, 4000)}

## Rules
- isJobPost=false for anything that isn't a concrete hiring post (news, "I got a job", congratulations, generic advice, product promo).
- applyMethod: "link" if there's an apply URL/ATS link; "dm_author" if it says to DM/message the poster; "comment" if it says to comment; "unclear" otherwise.
- company/role: best guess from the text; null if truly unknown.
- extractedJd: a tidy 2-5 sentence summary of the role + requirements (or null).

Respond with ONLY this JSON:
{ "isJobPost": <bool>, "company": <string|null>, "role": <string|null>, "requirements": <string|null>, "applyMethod": "link|dm_author|comment|unclear", "applyUrl": <string|null>, "extractedJd": <string|null> }`;
}

export async function extractPost(postText: string): Promise<Extraction | null> {
  try {
    const res = await chatCompletion(
      [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "user", content: extractPrompt(postText) },
      ],
      { temperature: 0.1, response_format: { type: "json_object" }, purpose: "post_extraction" }
    );
    return parseJsonResponse<Extraction>(res.text);
  } catch (err) {
    console.warn("[linkedin-posts] extraction failed:", err);
    return null;
  }
}

export function postText(p: LinkedinPostItem): string {
  return p.text ?? p.content ?? "";
}
function postUrl(p: LinkedinPostItem): string | undefined {
  return p.share_url ?? p.post_url ?? p.url;
}
function authorName(p: LinkedinPostItem): string | undefined {
  return p.author?.name ?? ([p.author?.first_name, p.author?.last_name].filter(Boolean).join(" ") || undefined);
}
function authorUrl(p: LinkedinPostItem): string | undefined {
  return (
    p.author?.profile_url ??
    (p.author?.public_identifier ? `https://www.linkedin.com/in/${p.author.public_identifier}` : undefined)
  );
}

function toRawJob(p: LinkedinPostItem, ex: Extraction): RawJob | null {
  if (!ex.isJobPost) return null;
  const company = ex.company ?? "Unknown (LinkedIn post)";
  const role = ex.role ?? "Role from LinkedIn post";
  const pUrl = postUrl(p);
  const aUrl = authorUrl(p);

  // Routing (design §16 step 4)
  const isDmAuthor = ex.applyMethod === "dm_author" || ex.applyMethod === "comment";
  const applyType = isDmAuthor ? "REFERRAL_FIRST" : "MANUAL_NOTIFY";

  const jd = [ex.extractedJd, ex.requirements].filter(Boolean).join("\n\n") || postText(p).slice(0, 2000);

  return {
    source: "LINKEDIN_POST",
    company,
    role,
    jdText: jd,
    applyUrl: ex.applyUrl ?? pUrl ?? aUrl ?? "https://www.linkedin.com",
    jobProviderId: p.id,
    sourcePostUrl: pUrl,
    applyType,
    postedAt: p.date || p.posted_at ? new Date(p.date ?? p.posted_at!) : undefined,
    // dm_author/comment → the author becomes the outreach target.
    ...(isDmAuthor && aUrl ? { sourcePostAuthorUrl: aUrl, sourcePostAuthorName: authorName(p) } : {}),
  };
}

export async function fetchLinkedinPosts(keyword: string, search: SearchCfg): Promise<RawJob[]> {
  const accountId = config.owner.linkedinAccountId;
  if (!accountId) return [];

  let items: LinkedinPostItem[] = [];
  try {
    const res = await linkedinSearch<LinkedinPostItem>(accountId, {
      api: "classic",
      category: "posts",
      keywords: `${keyword} hiring`,
      date_posted: search.recencyDays,
      sort_by: "date",
    } as Parameters<typeof linkedinSearch>[1]);
    items = res.items ?? [];
  } catch (err) {
    console.error(`[linkedin-posts] search failed for "${keyword}":`, err);
    return [];
  }

  // Step 2 — pre-filter for hiring signal (free).
  const signalled = items.filter((p) => hasHiringSignal(postText(p)));

  // Skip posts already run through extraction in a previous tick — the keyword
  // search keeps returning them while they're recent (mirrors linkedin-feed.ts).
  // Posts without an id can't be deduped, so we always (re)process them. Dedup
  // BEFORE the cap so the LLM budget is spent on unseen posts.
  const withId = signalled.filter((p) => p.id);
  const unprocessedIds = new Set(await filterUnprocessed(withId.map((p) => p.id!)));
  const candidates = signalled
    .filter((p) => !p.id || unprocessedIds.has(p.id))
    .slice(0, MAX_POSTS_PER_KEYWORD);
  if (candidates.length === 0) return [];

  // Step 3 — AI extraction on survivors only.
  const extracted = await Promise.allSettled(
    candidates.map(async (p) => {
      const ex = await extractPost(postText(p));
      const job = ex ? toRawJob(p, ex) : null;
      // ex === null is a transient extraction failure — leave it unmarked to retry
      // next run. A definitive result (job or not) gets marked so we never re-extract.
      return { id: p.id, marked: ex !== null, job };
    })
  );

  const settled = extracted
    .filter((r): r is PromiseFulfilledResult<{ id: string | undefined; marked: boolean; job: RawJob | null }> => r.status === "fulfilled")
    .map((r) => r.value);

  await markProcessed(settled.filter((r) => r.marked && r.id).map((r) => r.id!));

  return settled.map((r) => r.job).filter((j): j is RawJob => j !== null);
}
