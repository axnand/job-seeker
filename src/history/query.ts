/**
 * Shared query logic for the /history page — parses+whitelists filter/sort
 * params and runs the Prisma query. Used directly by app/history/page.tsx
 * (no self-fetch — see app/jobs/[jobId]/page.tsx's note on why) and by the
 * thin GET wrapper at app/api/jobs/history/route.ts.
 */

import { prisma } from "@/lib/prisma";
import type { Prisma, AppStage, JobSource, SkipSource, ApplyType } from "@prisma/client";

const STAGES: AppStage[] = ["NEW", "APPROVED", "OUTREACH", "REPLIED", "APPLIED", "INTERVIEWING", "OFFER", "SKIPPED"];
const SKIP_SOURCES: SkipSource[] = ["MANUAL", "AI_TRIAGE", "AI_SCORE", "STALE", "BLACKLIST"];
const SOURCES: JobSource[] = ["LINKEDIN_JOB", "LINKEDIN_POST", "ADZUNA", "ATS_WATCHLIST", "REMOTIVE", "REMOTEOK", "JSEARCH", "MANUAL"];
const SORT_FIELDS = ["discoveredAt", "aiScore", "salaryAnnualBase", "company", "appStage"] as const;
export type HistorySortField = (typeof SORT_FIELDS)[number];

export interface HistoryParams {
  q: string | null;
  appStage: AppStage | null;
  skipSource: SkipSource | null;
  source: JobSource | null;
  salaryMin: number | null;
  salaryMax: number | null;
  dateFrom: Date | null;
  dateTo: Date | null;
  pinned: boolean;
  sort: HistorySortField;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
}

function num(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function date(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// A bare "YYYY-MM-DD" `dateTo` parses to midnight UTC — i.e. the very start of
// that day, excluding everything discovered later on it. Push it to the last
// instant of the day so the filter reads as "through end of dateTo", matching
// what the date picker visually implies.
function endOfDay(d: Date): Date {
  return new Date(d.getTime() + 24 * 60 * 60 * 1000 - 1);
}

export function parseHistoryParams(sp: Record<string, string | undefined>): HistoryParams {
  const appStage = sp.appStage && (STAGES as string[]).includes(sp.appStage) ? (sp.appStage as AppStage) : null;
  const skipSource = sp.skipSource && (SKIP_SOURCES as string[]).includes(sp.skipSource) ? (sp.skipSource as SkipSource) : null;
  const source = sp.source && (SOURCES as string[]).includes(sp.source) ? (sp.source as JobSource) : null;
  const sort = (SORT_FIELDS as readonly string[]).includes(sp.sort ?? "") ? (sp.sort as HistorySortField) : "discoveredAt";
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc";
  const page = Math.max(1, Math.floor(Number(sp.page)) || 1);
  const pageSize = Math.min(Math.max(1, Math.floor(Number(sp.pageSize)) || 25), 100);

  return {
    q: sp.q?.trim() || null,
    appStage,
    skipSource,
    source,
    salaryMin: num(sp.salaryMin),
    salaryMax: num(sp.salaryMax),
    dateFrom: date(sp.dateFrom),
    dateTo: (() => { const d = date(sp.dateTo); return d ? endOfDay(d) : null; })(),
    pinned: sp.pinned === "1",
    sort,
    dir,
    page,
    pageSize,
  };
}

function orderByFor(sort: HistorySortField, dir: "asc" | "desc"): Prisma.JobOrderByWithRelationInput {
  switch (sort) {
    // Nullable fields: push nulls (unscored/no-salary rows) to the end
    // regardless of direction — an unranked row isn't "highest" in a desc sort.
    case "aiScore": return { aiScore: { sort: dir, nulls: "last" } };
    case "salaryAnnualBase": return { salaryAnnualBase: { sort: dir, nulls: "last" } };
    case "company": return { company: dir };
    case "appStage": return { appStage: dir };
    case "discoveredAt": default: return { discoveredAt: dir };
  }
}

export interface HistoryJob {
  id: string;
  company: string;
  role: string;
  source: JobSource;
  appStage: AppStage;
  skipSource: SkipSource | null;
  applyType: ApplyType;
  applyUrl: string;
  aiScore: number | null;
  salaryAnnualBase: number | null;
  salaryCurrency: string | null;
  discoveredAt: Date;
  pinned: boolean;
  closedAt: Date | null;
  location: string | null;
}

export interface HistoryResult {
  jobs: HistoryJob[];
  total: number;
  page: number;
  pageSize: number;
}

export async function fetchHistory(params: HistoryParams): Promise<HistoryResult> {
  const where: Prisma.JobWhereInput = {
    ...(params.appStage ? { appStage: params.appStage } : {}),
    ...(params.skipSource ? { skipSource: params.skipSource } : {}),
    ...(params.source ? { source: params.source } : {}),
    ...(params.pinned ? { pinned: true } : {}),
    ...(params.salaryMin != null || params.salaryMax != null
      ? {
          salaryAnnualBase: {
            ...(params.salaryMin != null ? { gte: params.salaryMin } : {}),
            ...(params.salaryMax != null ? { lte: params.salaryMax } : {}),
          },
        }
      : {}),
    ...(params.dateFrom || params.dateTo
      ? {
          discoveredAt: {
            ...(params.dateFrom ? { gte: params.dateFrom } : {}),
            ...(params.dateTo ? { lte: params.dateTo } : {}),
          },
        }
      : {}),
    ...(params.q
      ? {
          OR: [
            { company: { contains: params.q, mode: "insensitive" } },
            { role: { contains: params.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [jobs, total] = await Promise.all([
    prisma.job.findMany({
      where,
      orderBy: orderByFor(params.sort, params.dir),
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      select: {
        id: true, company: true, role: true, source: true, appStage: true,
        skipSource: true, applyType: true, applyUrl: true, aiScore: true, salaryAnnualBase: true,
        salaryCurrency: true, discoveredAt: true, pinned: true, closedAt: true, location: true,
      },
    }),
    prisma.job.count({ where }),
  ]);

  return { jobs, total, page: params.page, pageSize: params.pageSize };
}
