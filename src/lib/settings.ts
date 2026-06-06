/**
 * Runtime settings — DB row merged over config.ts defaults.
 * config.ts is the source of types and fallback values.
 * The DB row stores only the keys the owner has overridden.
 *
 * Usage:
 *   const s = await getSettings();
 *   s.sources.jsearch   // true/false from DB (or config default)
 */

import { prisma } from "./prisma";
import { config } from "@/config";

export interface AppSettingsData {
  // Sources
  sources: {
    linkedin:     boolean;
    adzuna:       boolean;
    atsWatchlist: boolean;
    remotive:     boolean;
    remoteok:     boolean;
    jsearch:      boolean;
  };
  // Search
  search: {
    keywords:             string[];
    location:             string;
    relevanceThreshold:   number;
    minSalaryAmount:      number;
    minSalaryCurrency:    string;
    strictSalary:         boolean;
    blacklistedCompanies: string[];
  };
  // Outreach
  outreach: {
    globalPause:             boolean;
    maxReferralTargetsPerJob:number;
    followupAfterDays:       number;
    maxFollowups:            number;
    recontactCooldownDays:   number;
    dailyInviteCap:          number;
    weeklyInviteCap:         number;
    dailyDmCap:              number;
    sendWindowStart:         number;
    sendWindowEnd:           number;
  };
  // AI
  ai: {
    enableResumeTailoring: boolean;
    defaultModel:          string;
  };
}

function defaults(): AppSettingsData {
  return {
    sources: { ...config.sources },
    search: {
      keywords:             [...config.search.keywords],
      location:             config.search.location,
      relevanceThreshold:   config.search.relevanceThreshold,
      minSalaryAmount:      config.search.minSalary.amount,
      minSalaryCurrency:    config.search.minSalary.currency,
      strictSalary:         config.search.strictSalary,
      blacklistedCompanies: [...config.search.blacklistedCompanies],
    },
    outreach: {
      globalPause:              config.outreach.globalPause,
      maxReferralTargetsPerJob: config.outreach.maxReferralTargetsPerJob,
      followupAfterDays:        config.outreach.followupAfterDays,
      maxFollowups:             config.outreach.maxFollowups,
      recontactCooldownDays:    config.outreach.recontactCooldownDays,
      dailyInviteCap:           config.outreach.dailyInviteCap,
      weeklyInviteCap:          config.outreach.weeklyInviteCap,
      dailyDmCap:               config.outreach.dailyDmCap,
      sendWindowStart:          config.outreach.sendWindowStart,
      sendWindowEnd:            config.outreach.sendWindowEnd,
    },
    ai: {
      enableResumeTailoring: config.ai.enableResumeTailoring,
      defaultModel:          config.ai.defaultModel,
    },
  };
}

let _cache: AppSettingsData | null = null;
let _cachedAt = 0;
const CACHE_TTL = 60_000; // 1 min — cron reads this frequently

export async function getSettings(): Promise<AppSettingsData> {
  const now = Date.now();
  if (_cache && now - _cachedAt < CACHE_TTL) return _cache;

  try {
    const row = await prisma.appSettings.findUnique({ where: { id: "default" } });
    const d = defaults();
    if (row?.data) {
      // Deep-merge DB data over defaults so missing keys always have a fallback
      const db = row.data as Partial<AppSettingsData>;
      _cache = {
        sources:  { ...d.sources,  ...(db.sources  ?? {}) },
        search:   { ...d.search,   ...(db.search   ?? {}) },
        outreach: { ...d.outreach, ...(db.outreach ?? {}) },
        ai:       { ...d.ai,       ...(db.ai       ?? {}) },
      };
    } else {
      _cache = d;
    }
  } catch {
    _cache = defaults();
  }

  _cachedAt = Date.now();
  return _cache;
}

export async function updateSettings(
  patch: Partial<AppSettingsData>
): Promise<AppSettingsData> {
  const current = await getSettings();
  const merged: AppSettingsData = {
    sources:  { ...current.sources,  ...(patch.sources  ?? {}) },
    search:   { ...current.search,   ...(patch.search   ?? {}) },
    outreach: { ...current.outreach, ...(patch.outreach ?? {}) },
    ai:       { ...current.ai,       ...(patch.ai       ?? {}) },
  };

  await prisma.appSettings.upsert({
    where:  { id: "default" },
    create: { id: "default", data: merged as object },
    update: { data: merged as object },
  });

  _cache = merged;
  _cachedAt = Date.now();
  return merged;
}
