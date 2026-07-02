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

type JobLike = { id: string; company: string; role: string; closedAt: Date | null };

export async function resolveActiveRole(job: JobLike): Promise<ActiveRole> {
  // Open role: speak for itself.
  if (!job.closedAt) {
    const self = await prisma.job.findUnique({ where: { id: job.id }, select: { tailoredPitch: true } });
    return { jobId: job.id, role: job.role, pitch: self?.tailoredPitch ?? null, redirected: false };
  }

  // Closed role: find the company's open siblings and pick the best fit.
  const key = companyKey(job.company);
  const candidates = await prisma.job.findMany({
    where: { appStage: { not: "SKIPPED" }, closedAt: null, id: { not: job.id } },
    select: { id: true, company: true, role: true, aiScore: true, tailoredPitch: true, createdAt: true },
  });
  const siblings = candidates.filter((c) => companyKey(c.company) === key);

  if (siblings.length === 0) {
    const self = await prisma.job.findUnique({ where: { id: job.id }, select: { tailoredPitch: true } });
    return { jobId: job.id, role: job.role, pitch: self?.tailoredPitch ?? null, redirected: false };
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
