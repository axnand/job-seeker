/**
 * Persistent LinkedIn ID cache — survives Vercel cold starts.
 * Stored in AppSettings.data under "idCache" (no extra table needed).
 *
 * Keys:
 *   location:<text>   → LinkedIn region/location id
 *   company:<name>    → LinkedIn company id (TTL 7 days)
 */

import { prisma } from "./prisma";

const COMPANY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
