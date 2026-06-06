/**
 * Runtime settings — DB row merged over config.ts defaults.
 * config.ts is the source of types and fallback values; the DB row stores
 * overrides. EVERYTHING tunable lives here so nothing needs a code edit.
 *
 *   const s = await getSettings();
 *   s.search.recencyDays   // from DB (or config default)
 */

import { prisma } from "./prisma";
import { config } from "@/config";

export interface AppSettingsData {
  sources: {
    linkedin: boolean; linkedinPosts: boolean; adzuna: boolean; atsWatchlist: boolean;
    remotive: boolean; remoteok: boolean; jsearch: boolean;
  };
  search: {
    keywords:             string[];
    location:             string;
    recencyDays:          number;
    relevanceThreshold:   number;
    minSalaryAmount:      number;
    minSalaryCurrency:    string;
    baseCurrency:         string;
    strictSalary:         boolean;
    blacklistedCompanies: string[];
    // LinkedIn native job filters
    linkedinSeniority:    string[]; // entry | associate | mid_senior | director | executive | intern
    linkedinPresence:     string[]; // remote | hybrid | on_site
    linkedinJobType:      string[]; // full_time | part_time | contract | internship
  };
  // Candidate profile — drives the AI scoring rubric
  profile: {
    summary:             string;
    targetRoles:         string[];
    preferredIndustries: string[];
    seniorityLevel:      string;
    currentBaseLPA:      number;
    acceptableSeniority: string[];
    rejectSeniority:     string[];
  };
  outreach: {
    globalPause: boolean; maxReferralTargetsPerJob: number;
    connectTarget: number; maxInvitesPerJob: number;
    replenishIntervalHours: number; inviteTimeoutDays: number;
    followupAfterDays: number; maxFollowups: number; recontactCooldownDays: number;
    dailyInviteCap: number; weeklyInviteCap: number; dailyDmCap: number;
    sendWindowStart: number; sendWindowEnd: number;
  };
  staleness: {
    archiveAfterDays:       number;
    noNewOutreachAfterDays: number;
  };
  targetCompanies: Array<{ name: string; ats: "greenhouse" | "lever" | "ashby"; boardToken: string }>;
  templates: { connectionNote: string; firstDm: string; followup: string };
  ai: {
    enableResumeTailoring: boolean;
    defaultModel:          string;
  };
}

function defaults(): AppSettingsData {
  const c = config;
  return {
    sources: { ...c.sources },
    search: {
      keywords:             [...c.search.keywords],
      location:             c.search.location,
      recencyDays:          c.search.recencyDays,
      relevanceThreshold:   c.search.relevanceThreshold,
      minSalaryAmount:      c.search.minSalary.amount,
      minSalaryCurrency:    c.search.minSalary.currency,
      baseCurrency:         c.search.baseCurrency,
      strictSalary:         c.search.strictSalary,
      blacklistedCompanies: [...c.search.blacklistedCompanies],
      linkedinSeniority:    [...c.search.linkedinSeniority],
      linkedinPresence:     [...c.search.linkedinPresence],
      linkedinJobType:      [...c.search.linkedinJobType],
    },
    profile: {
      summary:             c.resume.summary,
      targetRoles:         [...c.resume.targetRoles],
      preferredIndustries: [...c.resume.preferredIndustries],
      seniorityLevel:      c.resume.seniorityLevel,
      currentBaseLPA:      c.resume.constraints.currentBaseLPA,
      acceptableSeniority: [...c.resume.constraints.acceptableSeniority],
      rejectSeniority:     [...c.resume.constraints.rejectSeniority],
    },
    outreach: {
      globalPause:              c.outreach.globalPause,
      maxReferralTargetsPerJob: c.outreach.maxReferralTargetsPerJob,
      connectTarget:            c.outreach.connectTarget,
      maxInvitesPerJob:         c.outreach.maxInvitesPerJob,
      replenishIntervalHours:   c.outreach.replenishIntervalHours,
      inviteTimeoutDays:        c.outreach.inviteTimeoutDays,
      followupAfterDays:        c.outreach.followupAfterDays,
      maxFollowups:             c.outreach.maxFollowups,
      recontactCooldownDays:    c.outreach.recontactCooldownDays,
      dailyInviteCap:           c.outreach.dailyInviteCap,
      weeklyInviteCap:          c.outreach.weeklyInviteCap,
      dailyDmCap:               c.outreach.dailyDmCap,
      sendWindowStart:          c.outreach.sendWindowStart,
      sendWindowEnd:            c.outreach.sendWindowEnd,
    },
    staleness: {
      archiveAfterDays:       c.staleness.archiveAfterDays,
      noNewOutreachAfterDays: c.staleness.noNewOutreachAfterDays,
    },
    targetCompanies: [...c.targetCompanies],
    templates: { ...c.templates },
    ai: {
      enableResumeTailoring: c.ai.enableResumeTailoring,
      defaultModel:          c.ai.defaultModel,
    },
  };
}

/** Merge DB overrides over defaults, section by section (per-key for objects). */
function merge(base: AppSettingsData, db: Partial<AppSettingsData>): AppSettingsData {
  return {
    sources:         { ...base.sources,   ...(db.sources   ?? {}) },
    search:          { ...base.search,    ...(db.search    ?? {}) },
    profile:         { ...base.profile,   ...(db.profile   ?? {}) },
    outreach:        { ...base.outreach,  ...(db.outreach  ?? {}) },
    staleness:       { ...base.staleness, ...(db.staleness ?? {}) },
    targetCompanies: db.targetCompanies ?? base.targetCompanies,
    templates:       { ...base.templates,  ...(db.templates ?? {}) },
    ai:              { ...base.ai,        ...(db.ai        ?? {}) },
  };
}

let _cache: AppSettingsData | null = null;
let _cachedAt = 0;
const CACHE_TTL = 60_000;

export async function getSettings(): Promise<AppSettingsData> {
  if (_cache && Date.now() - _cachedAt < CACHE_TTL) return _cache;
  try {
    const row = await prisma.appSettings.findUnique({ where: { id: "default" } });
    _cache = row?.data ? merge(defaults(), row.data as Partial<AppSettingsData>) : defaults();
  } catch {
    _cache = defaults();
  }
  _cachedAt = Date.now();
  return _cache;
}

export async function updateSettings(patch: Partial<AppSettingsData>): Promise<AppSettingsData> {
  const merged = merge(await getSettings(), patch);
  await prisma.appSettings.upsert({
    where:  { id: "default" },
    create: { id: "default", data: merged as object },
    update: { data: merged as object },
  });
  _cache = merged;
  _cachedAt = Date.now();
  return merged;
}
