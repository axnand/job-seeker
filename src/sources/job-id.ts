/**
 * Resolve the requisition/job ID from an apply link.
 *
 * Most feed posts just say "we're hiring, apply here: <link>" with no "DM me".
 * We still want a referral, and a referrer needs the job's ID to submit you in
 * their ATS — so we follow the link (LinkedIn lnkd.in shortlinks and the
 * "you're leaving LinkedIn" safety-redirect included) and pull the ID out of the
 * final URL, falling back to a light scan of the page body.
 *
 * Best-effort: returns null if the link blocks bots or encodes no ID. The DM
 * then simply omits the ID (graceful degradation) — we never block on this.
 */

const FETCH_TIMEOUT_MS = 10_000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** A URL we should NOT treat as an apply link (the author's profile, the post itself). */
function isApplyLink(url: string | undefined): url is string {
  if (!url) return false;
  return /^https?:\/\//i.test(url) && !/linkedin\.com\/(in|posts|feed)\//i.test(url);
}

/** Unwrap LinkedIn's "you're leaving LinkedIn" interstitial (?url=<encoded>). */
function unwrapLinkedInRedirect(url: string): string {
  try {
    const u = new URL(url);
    if (/linkedin\.com$/i.test(u.hostname) && /\/(redir|safety)/i.test(u.pathname)) {
      const target = u.searchParams.get("url");
      if (target) return decodeURIComponent(target);
    }
  } catch { /* ignore */ }
  return url;
}

/** Follow redirects (shortlinks → ATS) and return the final destination URL. */
async function resolveFinalUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return unwrapLinkedInRedirect(res.url || url);
  } catch {
    return url; // network/blocked — fall back to extracting from the raw link
  }
}

// ATS-specific ID patterns, tried in order against the resolved URL. Each capture
// group 1 is the ID. Ordered most-specific-first.
const URL_PATTERNS: RegExp[] = [
  /[?&]gh_jid=(\d+)/i,                                  // Greenhouse (param)
  /greenhouse\.io\/(?:embed\/)?[^/?]+\/jobs\/(\d+)/i,   // Greenhouse (path)
  /lever\.co\/[^/]+\/([0-9a-f]{8}-[0-9a-f-]{27,})/i,    // Lever (UUID)
  /ashbyhq\.com\/[^/]+\/([0-9a-f]{8}-[0-9a-f-]{27,})/i, // Ashby (UUID)
  /linkedin\.com\/jobs\/view\/(\d+)/i,                  // LinkedIn job
  /myworkdayjobs\.com\/.+?_([A-Za-z]{1,4}-?\d{3,})/i,   // Workday (JR-/R- id)
  /smartrecruiters\.com\/[^/]+\/(\d{6,})/i,             // SmartRecruiters
  /workable\.com\/[^/]+\/j\/([0-9A-F]{6,})/i,           // Workable
  /[?&](?:jobId|job_id|requisitionId|reqId|positionId|posting_id)=([\w-]+)/i, // generic param
  /\/jobs?\/(\d{4,})\b/i,                               // generic numeric path id
];

function idFromUrl(url: string): string | null {
  for (const re of URL_PATTERNS) {
    const m = url.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

// Last-resort patterns against the page body (no LLM).
const BODY_PATTERNS: RegExp[] = [
  /[?&]gh_jid=(\d+)/i,
  /\b(?:job|requisition|posting|position)\s*(?:id|number|no\.?|#)\s*[:#]?\s*([A-Za-z]{0,4}-?\d{3,})/i,
  /\breq(?:uisition)?\s*(?:id|#)?\s*[:#]?\s*([A-Za-z]{0,4}-?\d{3,})/i,
];

async function idFromBody(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 200_000); // cap to keep regex cheap
    for (const re of BODY_PATTERNS) {
      const m = html.match(re);
      if (m?.[1]) return m[1];
    }
  } catch { /* blocked / timeout */ }
  return null;
}

export interface ResolvedJob {
  jobId: string | null;
  resolvedUrl: string; // final apply URL after following redirects
}

/**
 * Resolve an apply link to { jobId, resolvedUrl }. Follows redirects once, reads
 * the ID from the URL, and only fetches the page body if the URL had none.
 */
export async function resolveJobId(applyUrl: string | undefined): Promise<ResolvedJob | null> {
  if (!isApplyLink(applyUrl)) return null;
  const resolvedUrl = await resolveFinalUrl(applyUrl);
  let jobId = idFromUrl(resolvedUrl);
  if (!jobId) jobId = await idFromBody(resolvedUrl);
  return { jobId, resolvedUrl };
}
