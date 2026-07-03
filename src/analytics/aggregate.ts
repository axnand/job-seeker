/**
 * Conversion analytics — aggregate the "which sources and messages actually
 * convert" picture from data that already exists (Job.source + appStage,
 * Outreach → ChannelThread.status/providerState).
 *
 * Two queries, no N+1:
 *   1. job.groupBy(source, appStage)  → per-source discovery/scoring/approval +
 *      the overall per-stage pipeline counts.
 *   2. outreach.findMany(join job.source + thread)  → per-source outreach funnel
 *      (invites sent → accepted → replied), aggregated in memory.
 *
 * Thread → funnel-signal classification mirrors computeOutreachCounts in
 * app/api/jobs/route.ts so the numbers line up with the board:
 *   • invite sent : phase INVITE_PENDING | CONNECTED | MESSAGED, or status REPLIED
 *   • accepted    : phase CONNECTED | MESSAGED, or status REPLIED  (CONNECTED+)
 *   • replied     : status REPLIED
 *   ARCHIVED threads (timed-out / cancelled invites) are excluded.
 */

import { prisma } from "@/lib/prisma";
import type { AppStage, JobSource } from "@prisma/client";

// Stages that count as "approved and beyond" — everything the owner acted on
// past the NEW triage gate (APP_RANK >= APPROVED, excluding SKIPPED).
const APPROVED_PLUS: AppStage[] = ["APPROVED", "OUTREACH", "REPLIED", "APPLIED", "INTERVIEWING", "OFFER"];
// Post-referral pipeline — jobs the owner is actively carrying to an outcome.
const IN_PIPELINE: AppStage[] = ["APPLIED", "INTERVIEWING", "OFFER"];
// Every stage, in funnel order, for the per-stage pipeline breakdown.
export const ALL_STAGES: AppStage[] = ["NEW", "APPROVED", "OUTREACH", "REPLIED", "APPLIED", "INTERVIEWING", "OFFER", "SKIPPED"];

export interface SourceRow {
  source: JobSource;
  jobs: number;          // discovered
  passedScoring: number; // not SKIPPED
  approvedPlus: number;  // APPROVED and beyond
  invitesSent: number;
  accepted: number;
  replied: number;
}

export interface AnalyticsData {
  totals: {
    jobs: number;
    passedScoring: number;
    approvedPlus: number;
    invitesSent: number;
    accepted: number;
    replied: number;
    inPipeline: number;
    // Ratios in [0,1], or null when the denominator is 0 (empty / no data yet).
    approvalRate: number | null;      // approvedPlus / passedScoring
    inviteAcceptRate: number | null;  // accepted / invitesSent
    acceptReplyRate: number | null;   // replied / accepted
  };
  pipeline: Record<AppStage, number>;
  bySource: SourceRow[];
}

const rate = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export async function computeAnalytics(): Promise<AnalyticsData> {
  const [stageGroups, outreaches] = await Promise.all([
    prisma.job.groupBy({
      by: ["source", "appStage"],
      _count: { _all: true },
    }),
    prisma.outreach.findMany({
      select: {
        job: { select: { source: true } },
        thread: { select: { status: true, providerState: true } },
      },
    }),
  ]);

  // ── Per-source + overall pipeline from the job stage groups ────────────────
  const bySource = new Map<JobSource, SourceRow>();
  const pipeline = Object.fromEntries(ALL_STAGES.map((s) => [s, 0])) as Record<AppStage, number>;

  const row = (source: JobSource): SourceRow => {
    let r = bySource.get(source);
    if (!r) {
      r = { source, jobs: 0, passedScoring: 0, approvedPlus: 0, invitesSent: 0, accepted: 0, replied: 0 };
      bySource.set(source, r);
    }
    return r;
  };

  for (const g of stageGroups) {
    const n = g._count._all;
    const r = row(g.source);
    r.jobs += n;
    if (g.appStage !== "SKIPPED") r.passedScoring += n;
    if (APPROVED_PLUS.includes(g.appStage)) r.approvedPlus += n;
    pipeline[g.appStage] += n;
  }

  // ── Per-source outreach funnel from the joined threads ─────────────────────
  for (const o of outreaches) {
    const t = o.thread;
    if (!t || t.status === "ARCHIVED") continue;
    const r = row(o.job.source);
    const phase = (t.providerState as { phase?: string } | null)?.phase;
    const isReplied = t.status === "REPLIED";
    const isAccepted = isReplied || phase === "CONNECTED" || phase === "MESSAGED";
    const isSent = isAccepted || phase === "INVITE_PENDING";
    if (isSent) r.invitesSent++;
    if (isAccepted) r.accepted++;
    if (isReplied) r.replied++;
  }

  // ── Totals ─────────────────────────────────────────────────────────────────
  const totals = {
    jobs: 0, passedScoring: 0, approvedPlus: 0, invitesSent: 0, accepted: 0, replied: 0,
  };
  for (const r of bySource.values()) {
    totals.jobs += r.jobs;
    totals.passedScoring += r.passedScoring;
    totals.approvedPlus += r.approvedPlus;
    totals.invitesSent += r.invitesSent;
    totals.accepted += r.accepted;
    totals.replied += r.replied;
  }
  const inPipeline = IN_PIPELINE.reduce((a, s) => a + pipeline[s], 0);

  return {
    totals: {
      ...totals,
      inPipeline,
      approvalRate: rate(totals.approvedPlus, totals.passedScoring),
      inviteAcceptRate: rate(totals.accepted, totals.invitesSent),
      acceptReplyRate: rate(totals.replied, totals.accepted),
    },
    pipeline,
    // Most-discovered source first; the funnel table reads top-down.
    bySource: [...bySource.values()].sort((a, b) => b.jobs - a.jobs),
  };
}
