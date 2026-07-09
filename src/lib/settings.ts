/**
 * Runtime settings — DB row merged over config.ts defaults.
 * config.ts is the source of types and fallback values; the DB row stores
 * overrides. EVERYTHING tunable lives here so nothing needs a code edit.
 *
 *   const s = await getSettings();
 *   s.search.recencyDays   // from DB (or config default)
 */

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { config } from "@/config";

export interface AppSettingsData {
  sources: {
    linkedin: boolean; linkedinPosts: boolean; linkedinFeed: boolean; adzuna: boolean; atsWatchlist: boolean;
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
    globalPause: boolean;
    // Auto-pause bookkeeping (set by safety.ts). pauseKind "transient" (429)
    // auto-resumes after a cooldown; "hard" (account restricted) stays until
    // manually cleared. Null when not auto-paused.
    pausedAt?: string | null;
    pauseKind?: "transient" | "hard" | null;
    maxReferralTargetsPerJob: number;
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
  feedAuthors: Array<{ name: string; publicId: string }>;
  templates: { connectionNote: string; firstDm: string; followup: string };
  ai: {
    enableResumeTailoring: boolean;
    // Truthfulness gate for auto-tailoring. true = only rephrase/reorder existing
    // facts (whitelist enforced). false = relaxed: may add adjacent JD-relevant
    // skills. See config.ai.truthfulTailoring + src/resume/whitelist.ts.
    truthfulTailoring:     boolean;
    defaultModel:          string;
    triageModel:           string; // cheap pre-scoring pass (see src/scoring/triage.ts)
  };
  // Alternate identity for DIRECT applications (dual-application strategy):
  // the alt resume swaps the master's contact block to these values.
  altIdentity: {
    email: string;
    phone: string;
  };
  // Machine-owned operational markers (not user-facing settings).
  ops: {
    lastWeeklyReportAt?: string | null; // ISO — gates the Monday analytics email
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
      pausedAt:                 null,
      pauseKind:                null,
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
    feedAuthors: [...c.feedAuthors],
    templates: { ...c.templates },
    ai: {
      enableResumeTailoring: c.ai.enableResumeTailoring,
      truthfulTailoring:     c.ai.truthfulTailoring,
      defaultModel:          c.ai.defaultModel,
      triageModel:           c.ai.triageModel,
    },
    altIdentity: {
      email: "",
      phone: "",
    },
    ops: {
      lastWeeklyReportAt: null,
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
    feedAuthors:     db.feedAuthors ?? base.feedAuthors,
    templates:       { ...base.templates,  ...(db.templates ?? {}) },
    ai:              { ...base.ai,        ...(db.ai        ?? {}) },
    altIdentity:     { ...base.altIdentity, ...(db.altIdentity ?? {}) },
    ops:             { ...base.ops,       ...(db.ops       ?? {}) },
  };
}

let _cache: AppSettingsData | null = null;
let _cachedAt = 0;
// Lowered 60s → 10s so safety-critical reads (e.g. the tick checking
// outreach.globalPause, which another instance may have just set) go stale in
// ≤10s instead of ≤60s. Trade-off: ~6× more reads of one tiny single-row
// table — negligible. A getSettingsFresh() cache-bypass for the few safety
// call sites would be tighter, but that means editing other files.
const CACHE_TTL = 10_000;
// Retries for a Serializable write-conflict (two updaters racing the same row).
const TX_MAX_RETRIES = 3;

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
  // Read-merge-write in ONE Serializable transaction. Reading the row FRESH
  // from the DB (never the 60s cache) means we merge the patch onto whatever is
  // actually persisted, so we never clobber sibling sections another process
  // wrote (e.g. the cron toggling outreach.globalPause vs a dashboard editing
  // search.*). Serializable makes a concurrent racer fail with P2034 instead of
  // silently winning a lost-update; we just retry the whole read-merge-write.
  for (let attempt = 0; ; attempt++) {
    try {
      const merged = await prisma.$transaction(
        async (tx) => {
          const row = await tx.appSettings.findUnique({ where: { id: "default" } });
          const current = row?.data ? merge(defaults(), row.data as Partial<AppSettingsData>) : defaults();
          const next = merge(current, patch);
          await tx.appSettings.upsert({
            where:  { id: "default" },
            create: { id: "default", data: next as object },
            update: { data: next as object },
          });
          return next;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      _cache = merged;
      _cachedAt = Date.now();
      return merged;
    } catch (e) {
      if (attempt < TX_MAX_RETRIES && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034") continue;
      throw e;
    }
  }
}
