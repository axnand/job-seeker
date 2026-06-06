import { prisma } from "@/lib/prisma";
import { dedupeKey } from "./normalize";
import type { RawJob } from "./types";

/**
 * Filters out jobs we've already seen.
 * Two passes:
 *  1. In-batch dedup (same role from two sources in the same run).
 *  2. DB dedup (dedupeKey already exists, or jobProviderId already seen).
 */
export async function dedupeJobs(rawJobs: RawJob[]): Promise<RawJob[]> {
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
  const existingKeys = await prisma.job.findMany({
    where: { dedupeKey: { in: keys } },
    select: { dedupeKey: true },
  });
  const existingKeySet = new Set(existingKeys.map(j => j.dedupeKey));

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
    if (existingKeySet.has(key)) return false;
    if (job.jobProviderId && existingProviderIdSet.has(job.jobProviderId)) return false;
    return true;
  });
}
