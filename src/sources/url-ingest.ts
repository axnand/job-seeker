/**
 * Turn a pasted job URL into JD text for the Add-job flow.
 *
 * Chain, most-reliable first:
 *   1. LinkedIn job URLs → Unipile getJobDetail (authenticated, real JD —
 *      LinkedIn blocks anonymous scrapers, so this is the only reliable path).
 *   2. Jina reader (r.jina.ai) — returns clean text for most public pages.
 *   3. Direct fetch + naive HTML strip — last resort.
 *
 * Returns null when nothing produced usable text — the caller should surface
 * "paste the text instead" rather than creating a junk entry.
 */

import { getJobDetail } from "@/unipile/client";
import { config } from "@/config";

export interface IngestedPage {
  text: string;
  via: "unipile" | "jina" | "direct";
  // Pre-extracted fields when the source is structured (Unipile).
  company?: string;
  role?: string;
  location?: string;
  applyUrl?: string;
}

/** linkedin.com/jobs/view/4012345678 or ...currentJobId=4012345678 */
function linkedinJobId(url: string): string | null {
  const m = url.match(/linkedin\.com\/jobs\/view\/(\d+)/i) ?? url.match(/[?&]currentJobId=(\d+)/i);
  return m ? m[1] : null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#\d+;|&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

const MIN_USEFUL_CHARS = 300; // less than this is a login wall / error page, not a JD

export async function ingestJobUrl(url: string): Promise<IngestedPage | null> {
  // 1. LinkedIn job → authenticated Unipile fetch (structured, reliable).
  const liJobId = linkedinJobId(url);
  if (liJobId && config.owner.linkedinAccountId) {
    try {
      const d = await getJobDetail(config.owner.linkedinAccountId, liJobId);
      const text = [d.title, d.company, d.location, "", d.description].filter(v => v !== undefined).join("\n");
      if ((d.description ?? "").length >= MIN_USEFUL_CHARS) {
        return { text, via: "unipile", company: d.company, role: d.title, location: d.location, applyUrl: d.apply_url ?? url };
      }
    } catch (err) {
      console.error("[url-ingest] unipile job fetch failed:", (err as Error).message);
    }
  }

  // 2. Jina reader — pass the raw URL (no encoding; the reader expects
  //    r.jina.ai/https://example.com/...).
  try {
    const r = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: "text/plain" },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.ok) {
      const text = (await r.text()).trim();
      if (text.length >= MIN_USEFUL_CHARS) return { text: text.slice(0, 20_000), via: "jina" };
    }
  } catch { /* fall through */ }

  // 3. Direct fetch + strip — many job boards render server-side.
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "text/html",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) {
      const text = stripHtml(await r.text());
      if (text.length >= MIN_USEFUL_CHARS) return { text: text.slice(0, 20_000), via: "direct" };
    }
  } catch { /* fall through */ }

  return null;
}
