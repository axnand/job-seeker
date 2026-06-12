/**
 * Per-post idempotency for post-based sources.
 *
 * LinkedIn post-listing endpoints return the newest N posts every run, so the
 * same post resurfaces on every discovery tick while it's still recent. Fetching
 * is cheap (one API call), but running LLM extraction on the same post over and
 * over is not. This module records which posts have already been through
 * extraction so each post costs at most ONE LLM call, ever.
 *
 * Reuses the generic WebhookEvent marker table (id = "post:<providerPostId>") —
 * no new table/migration, and it's indexed on processedAt for pruning.
 */

import { prisma } from "@/lib/prisma";

const MARKER_PREFIX = "post:";
const PROVIDER = "post_source";
const EVENT_TYPE = "post_processed";

function markerId(postId: string): string {
  return `${MARKER_PREFIX}${postId}`;
}

/** Given candidate post ids, return only those NOT yet processed. */
export async function filterUnprocessed(postIds: string[]): Promise<string[]> {
  const ids = postIds.filter(Boolean);
  if (ids.length === 0) return [];
  try {
    const seen = await prisma.webhookEvent.findMany({
      where: { id: { in: ids.map(markerId) } },
      select: { id: true },
    });
    const seenSet = new Set(seen.map((e) => e.id));
    return ids.filter((id) => !seenSet.has(markerId(id)));
  } catch {
    // On a DB hiccup, fail OPEN (process them) rather than silently skip jobs.
    return ids;
  }
}

/** Mark posts processed so a later run skips extraction. Non-throwing. */
export async function markProcessed(postIds: string[]): Promise<void> {
  const ids = postIds.filter(Boolean);
  if (ids.length === 0) return;
  try {
    await prisma.webhookEvent.createMany({
      data: ids.map((id) => ({ id: markerId(id), provider: PROVIDER, eventType: EVENT_TYPE })),
      skipDuplicates: true,
    });
  } catch {
    /* non-critical — worst case we re-extract next run */
  }
}
