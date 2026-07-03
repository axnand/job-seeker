/**
 * Persistent LinkedIn ID cache — survives Vercel cold starts.
 * Stored in AppSettings.data under "idCache" (no extra table needed).
 *
 * Keys:
 *   location:<text>        → LinkedIn region/location id
 *   company:<name>         → LinkedIn company id (TTL 7 days)
 *   companySize:<id>       → employee_count number, or -1 if API returned no count (TTL 30 days)
 */

import { prisma } from "./prisma";

const COMPANY_TTL_MS      = 7  * 24 * 60 * 60 * 1000;
const COMPANY_SIZE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const JOB_DETAIL_TTL_MS   = 7  * 24 * 60 * 60 * 1000;

interface CacheEntry { id: string; cachedAt: number }
type CacheStore = Record<string, CacheEntry>;

async function readStore(): Promise<CacheStore> {
  try {
    const row = await prisma.appSettings.findUnique({ where: { id: "default" } });
    return ((row?.data as Record<string, unknown>)?.idCache as CacheStore) ?? {};
  } catch { return {}; }
}

async function writeEntry(key: string, id: string): Promise<void> {
  try {
    const row = await prisma.appSettings.findUnique({ where: { id: "default" } });
    const data = (row?.data as Record<string, unknown>) ?? {};
    const cache: CacheStore = (data.idCache as CacheStore) ?? {};
    cache[key] = { id, cachedAt: Date.now() };
    data.idCache = cache;
    await prisma.appSettings.upsert({
      where: { id: "default" },
      create: { id: "default", data: data as Parameters<typeof prisma.appSettings.create>[0]["data"]["data"] },
      update: { data: data as Parameters<typeof prisma.appSettings.update>[0]["data"]["data"] },
    });
  } catch { /* non-critical — live without it */ }
}

/** Get a cached LinkedIn location id (permanent — location IDs never change). */
export async function getCachedLocationId(text: string): Promise<string | null> {
  const store = await readStore();
  return store[`location:${text}`]?.id ?? null;
}

export async function setCachedLocationId(text: string, id: string): Promise<void> {
  await writeEntry(`location:${text}`, id);
}

/** Get a cached LinkedIn company id (TTL 7 days). */
export async function getCachedCompanyId(name: string): Promise<string | null> {
  const store = await readStore();
  const entry = store[`company:${name}`];
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > COMPANY_TTL_MS) return null; // expired
  return entry.id;
}

export async function setCachedCompanyId(name: string, id: string): Promise<void> {
  await writeEntry(`company:${name}`, id);
}

/**
 * Get cached company employee count by LinkedIn company_id.
 * Returns: number = known count, -1 = API returned no count (unknown), undefined = not cached.
 * TTL 30 days — company headcount changes slowly.
 */
export async function getCachedCompanySize(companyId: string): Promise<number | undefined> {
  const store = await readStore();
  const entry = store[`companySize:${companyId}`];
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > COMPANY_SIZE_TTL_MS) return undefined;
  return Number(entry.id); // stored as string in the generic cache
}

export async function setCachedCompanySize(companyId: string, count: number): Promise<void> {
  await writeEntry(`companySize:${companyId}`, String(count));
}

/**
 * Track LinkedIn jobs whose (paid) detail was already fetched, keyed by
 * jobProviderId (TTL 7 days). A hit means we pulled this job in a prior run and
 * already persisted it — the DB-dedup would drop it now anyway — so the caller
 * skips the detail call entirely.
 */
export async function hasFetchedJobDetail(jobProviderId: string): Promise<boolean> {
  const store = await readStore();
  const entry = store[`jobDetail:${jobProviderId}`];
  if (!entry) return false;
  return Date.now() - entry.cachedAt <= JOB_DETAIL_TTL_MS;
}

export async function markJobDetailFetched(jobProviderId: string): Promise<void> {
  await writeEntry(`jobDetail:${jobProviderId}`, jobProviderId);
}
