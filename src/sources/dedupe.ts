import { prisma } from "@/lib/prisma";
import { dedupeKey } from "./normalize";
import type { RawJob } from "./types";
import type { AppStage } from "@prisma/client";

// Stages where a job with this dedupeKey is still being acted on — a new posting
// with the same key is a genuine duplicate and must be suppressed.
const ACTIVE_STAGES: AppStage[] = ["NEW", "APPROVED", "OUTREACH", "REPLIED"];

/**
 * Filters out jobs we've already seen.
 * Two passes:
 *  1. In-batch dedup (same role from two sources in the same run).
 *  2. DB dedup:
 *     - jobProviderId already seen → always a duplicate (exact same posting).
 *     - dedupeKey already seen → duplicate ONLY if a prior same-key job is still
 *       active, or was created within `reAdmitAfterDays`. A role whose only
 *       prior matches are old AND closed (SKIPPED) is allowed back in, so a
 *       genuine re-post months later resurfaces instead of being silently lost.
 *
 * @param reAdmitAfterDays  how long after the last same-key posting a closed
 *                          role may resurface (default: staleness window, 30d).
 */
export async function dedupeJobs(rawJobs: RawJob[], reAdmitAfterDays = 30): Promise<RawJob[]> {
  // Pass 1 — in-batch
  const seenKeys = new Set<string>();
  const seenProviderIds = new Set<string>();
  const batchFiltered: RawJob[] = [];

  for (const job of rawJobs) {
    const key = dedupeKey(job.company, job.role, job.location);
    const pid = job.jobProviderId ? `${job.source}::${job.jobProviderId}` : null;

    if (seenKeys.has(key)) continue;
    if (pid && seenProviderIds.has(pid)) continue;

    seenKeys.add(key);
    if (pid) seenProviderIds.add(pid);
    batchFiltered.push(job);
  }

  if (batchFiltered.length === 0) return [];

  // Pass 2 — DB: check dedupeKey and jobProviderId
  const keys = batchFiltered.map(j => dedupeKey(j.company, j.role, j.location));
  const reAdmitCutoff = new Date(Date.now() - reAdmitAfterDays * 24 * 60 * 60 * 1000);
  const existingKeys = await prisma.job.findMany({
    where: { dedupeKey: { in: keys } },
    select: { dedupeKey: true, appStage: true, createdAt: true },
  });
  // A key blocks new postings only while a prior match is still active or recent.
  const blockedKeySet = new Set(
    existingKeys
      .filter(j => ACTIVE_STAGES.includes(j.appStage) || j.createdAt >= reAdmitCutoff)
      .map(j => j.dedupeKey)
  );

  const providerIds = batchFiltered
    .filter(j => j.jobProviderId)
    .map(j => j.jobProviderId!);

  const existingProviderIds =
    providerIds.length > 0
      ? await prisma.job.findMany({
          where: { jobProviderId: { in: providerIds } },
          select: { jobProviderId: true },
        })
      : [];
  const existingProviderIdSet = new Set(
    existingProviderIds.map(j => j.jobProviderId).filter(Boolean) as string[]
  );

  return batchFiltered.filter(job => {
    const key = dedupeKey(job.company, job.role, job.location);
    if (blockedKeySet.has(key)) return false;
    if (job.jobProviderId && existingProviderIdSet.has(job.jobProviderId)) return false;
    return true;
  });
}
