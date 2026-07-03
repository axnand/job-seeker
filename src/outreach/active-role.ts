/**
 * Active-role routing.
 *
 * When several postings from one company are pooled into a single card, outreach
 * must always speak for a role that is actually OPEN — never a closed one. For a
 * person originally sourced under a role that has since closed, we re-pitch them
 * on the company's best-fit open role (design: per-candidate best-fit, home-role
 * first, nearest open sibling as fallback).
 *
 * resolveActiveRole(job) returns the role string + pitch to use for THIS job's
 * messages right now:
 *   • job open                       → the job's own role/pitch (the common case)
 *   • job closed, open sibling found → the nearest open sibling (by title overlap,
 *                                       then aiScore, then recency)
 *   • job closed, no open sibling    → fall back to the job's own role (nothing
 *                                       better to offer; replenish has already
 *                                       stopped adding new people)
 */

import { prisma } from "@/lib/prisma";
import { companyKey } from "@/sources/normalize";
import { roleKeywords } from "./people-finder";

export interface ActiveRole {
  jobId: string;
  role: string;
  pitch: string | null;
  /** True when the active role differs from the job the thread was created under. */
  redirected: boolean;
}

/** Token-overlap score between two role titles (higher = more similar). */
function roleSimilarity(a: string, b: string): number {
  const ta = new Set(roleKeywords(a).split(" ").filter(Boolean));
  const tb = roleKeywords(b).split(" ").filter(Boolean);
  let hits = 0;
  for (const t of tb) if (ta.has(t)) hits++;
  return hits;
}

// The caller already has the loaded Job row (thread.outreach.job), so it passes
// tailoredPitch through — no need to re-fetch it for the open-role common case.
type JobLike = { id: string; company: string; role: string; closedAt: Date | null; tailoredPitch: string | null };

type OpenSibling = { id: string; company: string; role: string; aiScore: number | null; tailoredPitch: string | null; createdAt: Date };

// Per-tick memo of every open, non-skipped job. The closed-role path needs the
// company's open siblings, and re-querying the whole board once per thread is a
// hot N+1 during a tick. Both entry points (runOutreachTick, sendForJobs) call
// resetActiveRoleCache() up front and hold the "tick" lock, so the cache is only
// ever built/read single-threaded within one pass.
let openJobsCache: OpenSibling[] | null = null;

export function resetActiveRoleCache(): void {
  openJobsCache = null;
}

async function getOpenJobs(): Promise<OpenSibling[]> {
  if (!openJobsCache) {
    openJobsCache = await prisma.job.findMany({
      where: { appStage: { not: "SKIPPED" }, closedAt: null },
      select: { id: true, company: true, role: true, aiScore: true, tailoredPitch: true, createdAt: true },
    });
  }
  return openJobsCache;
}

export async function resolveActiveRole(job: JobLike): Promise<ActiveRole> {
  // Open role: speak for itself (pitch came in on the loaded job).
  if (!job.closedAt) {
    return { jobId: job.id, role: job.role, pitch: job.tailoredPitch ?? null, redirected: false };
  }

  // Closed role: find the company's open siblings and pick the best fit.
  const key = companyKey(job.company);
  const candidates = await getOpenJobs();
  const siblings = candidates.filter((c) => c.id !== job.id && companyKey(c.company) === key);

  if (siblings.length === 0) {
    return { jobId: job.id, role: job.role, pitch: job.tailoredPitch ?? null, redirected: false };
  }

  siblings.sort((a, b) => {
    const sim = roleSimilarity(job.role, b.role) - roleSimilarity(job.role, a.role);
    if (sim !== 0) return sim;
    const score = (b.aiScore ?? -1) - (a.aiScore ?? -1);
    if (score !== 0) return score;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  const best = siblings[0];
  return { jobId: best.id, role: best.role, pitch: best.tailoredPitch ?? null, redirected: true };
}
