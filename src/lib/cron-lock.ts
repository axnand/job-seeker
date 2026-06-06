/**
 * Lightweight DB row-lock so overlapping cron invocations don't double-run
 * (backlog #24). Reliable behind a transaction pooler (unlike session-level
 * pg advisory locks). A held lock older than STALE_MS is reclaimable so a
 * crashed run can't wedge the lock forever.
 */

import { prisma } from "./prisma";

const STALE_MS = 10 * 60 * 1000; // a run holding the lock longer than this is presumed dead

/**
 * Runs `fn` only if the named lock can be acquired. If another run holds a
 * fresh lock, returns { ran: false } without executing. Always releases on exit.
 */
export async function withCronLock<T>(
  name: string,
  fn: () => Promise<T>
): Promise<{ ran: true; result: T } | { ran: false }> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_MS);

  // Ensure the row exists (no-op if present).
  await prisma.cronLock.upsert({
    where: { name },
    create: { name, lockedAt: null },
    update: {},
  });

  // Atomically claim: only succeeds if free or stale.
  const claim = await prisma.cronLock.updateMany({
    where: { name, OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }] },
    data: { lockedAt: now },
  });
  if (claim.count === 0) {
    return { ran: false };
  }

  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    await prisma.cronLock
      .updateMany({ where: { name }, data: { lockedAt: null } })
      .catch((e) => console.error(`[cron-lock] failed to release "${name}":`, e));
  }
}
