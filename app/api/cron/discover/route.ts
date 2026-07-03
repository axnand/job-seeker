/**
 * POST /api/cron/discover
 * Triggered by Vercel Cron daily at 02:00 UTC (08:00 IST).
 * Protected by Bearer CRON_SECRET (enforced in middleware.ts).
 *
 * Steps:
 *  1. Fetch fresh jobs from all enabled source adapters
 *  2. Score + extract salary via LLM (batched to stay under function timeout)
 *  3. Persist passing jobs to DB
 *  4. Send daily digest email for jobs above the relevance threshold
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { discoverJobs } from "@/sources/registry";
import { scoreJob } from "@/scoring/ai-scorer";
import { triageJob } from "@/scoring/triage";
import { computePriority } from "@/scoring/priority";
import { normalizeSalary } from "@/salary/normalize";
import { dedupeKey } from "@/sources/normalize";
import { sendDailyDigest } from "@/email/digest";
import { sendFriendDigest } from "@/email/friend-digest";
import { sendScoringFailureAlert } from "@/email/alerts";
import { enqueueOutreach } from "@/outreach/enqueue";
import { getSettings, updateSettings } from "@/lib/settings";
import { withCronLock } from "@/lib/cron-lock";
import { sweepStaleJobs } from "@/status/staleness";
import { sweepPendingTailoring } from "@/resume/pipeline";
import { getCompanyProfile } from "@/unipile/client";
import { getCachedCompanySize, setCachedCompanySize } from "@/lib/id-cache";
import { config } from "@/config";
import type { AppStage, SalaryBasis, SalaryConfidence, SalaryPeriod, Job } from "@prisma/client";

const SCORE_CONCURRENCY = 6; // parallel LLM calls — fast without hammering rate limits

// Obvious non-engineering titles — dropped before the LLM to save calls + budget.
const NON_ENG = /\b(sales|account executive|recruiter|talent|copywriter|content writer|freelance writer|marketing|seo|designer|data (entry|analyst)|customer (support|success)|virtual assistant|teacher|tutor|nurse|driver|accountant|hr\b|business development|bdr|sdr)\b/i;

// Strong software-engineering signals. If the title carries one of these, we keep
// it even when NON_ENG also matches — so "Backend Engineer, Sales Platform" or
// "Software Engineer (Marketing Tools)" aren't wrongly dropped before scoring.
const ENG_OVERRIDE = /\b(software|back.?end|front.?end|full.?stack|sde|sdet|developer|programmer|devops|platform engineer|infrastructure|data engineer|ml engineer|machine learning|software development)\b/i;

// Title-level hard rejects — pure noise for an early-career candidate; the AI
// rubric would score these 0-25 anyway, so dropping them here saves the whole
// LLM call. Titles only (a JD *mentioning* "senior engineers" is fine).
// NOTE: "SDE II"/"Engineer II" stay (acceptable per profile); III+ rejects.
const TITLE_REJECT = /\b(senior|staff|principal|lead|architect|manager|director|head of|vp|vice president|chief|sr\.?)\b|\b(?:iii|iv)\b|\b(1[0-9]|[5-9])\s*\+\s*(?:years|yrs)\b|\b(intern|internship|apprentice|trainee|part.?time|freelance|contract(?:or)?)\b/i;

export const maxDuration = 300; // allow long runs on Vercel Pro; hobby caps at 60s

// ─── Company-size filter ─────────────────────────────────────────────────────

const MIN_EMPLOYEE_COUNT = 51; // drop confirmed 1–10 and 11–50 bands; keep ≥51

import type { RawJob } from "@/sources/types";

async function filterByCompanySize(jobs: RawJob[]): Promise<RawJob[]> {
  const accountId = config.owner.linkedinAccountId;
  const result: RawJob[] = [];

  for (const job of jobs) {
    if (!job.companyId || !accountId) {
      result.push(job); // no size data available — keep
      continue;
    }

    // Check cache first (30-day TTL)
    let count = await getCachedCompanySize(job.companyId).catch(() => undefined);

    if (count === undefined) {
      // Not cached — fetch and cache
      const profile = await getCompanyProfile(accountId, job.companyId);
      count = profile?.employee_count
        ?? profile?.employee_count_range?.from
        ?? -1; // -1 = API returned no count → treat as unknown
      await setCachedCompanySize(job.companyId, count).catch(() => {});
    }

    if (count !== -1 && count < MIN_EMPLOYEE_COUNT) {
      console.log(`[discover] filtered small company: ${job.company} (${count} employees)`);
      continue; // confirmed too small — drop
    }

    result.push(job); // confirmed large enough, or unknown size — keep
  }

  return result;
}

export async function POST() {
  try {
    // Advisory lock — skip if a previous run is still in flight (backlog #24).
    const locked = await withCronLock("discover", () => runDiscover());
    if (!locked.ran) {
      return NextResponse.json({ ok: true, skipped: "already running" });
    }
    return NextResponse.json(locked.result);
  } catch (err) {
    console.error("[discover] fatal error:", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

async function runDiscover() {
  {
    const [rawJobs, settings] = await Promise.all([discoverJobs(), getSettings()]);
    console.log(`[discover] ${rawJobs.length} fresh jobs after dedup`);

    const now = new Date();
    // Freshness window — only score jobs posted within recencyDays.
    const maxPostedAge = settings.search.recencyDays * 24 * 60 * 60 * 1000;

    // Drop old postings + obvious non-engineering/seniority-mismatched roles
    // before scoring — every drop here is a whole LLM call saved.
    const afterTitleFilter = rawJobs.filter(job => {
      if (NON_ENG.test(job.role) && !ENG_OVERRIDE.test(job.role)) return false;
      if (TITLE_REJECT.test(job.role)) return false;
      if (!job.postedAt) return true;                       // unknown age — keep
      return now.getTime() - job.postedAt.getTime() < maxPostedAge;
    });
    if (afterTitleFilter.length < rawJobs.length) {
      console.log(`[discover] title filters dropped ${rawJobs.length - afterTitleFilter.length} of ${rawJobs.length}`);
    }

    // Blacklist — companies explicitly excluded (low pay, bad fit, etc.)
    const blacklist = settings.search.blacklistedCompanies.map(c => c.toLowerCase());
    const afterBlacklist = blacklist.length === 0 ? afterTitleFilter : afterTitleFilter.filter(job => {
      const co = job.company.toLowerCase();
      const blocked = blacklist.some(b => co.includes(b) || b.includes(co));
      if (blocked) console.log(`[discover] blacklisted company: ${job.company}`);
      return !blocked;
    });

    // Company-size filter — drop confirmed micro companies (≤50 employees).
    // Only LinkedIn jobs carry a companyId; all other sources pass through.
    // Unknown size (fetch failed / no companyId) also passes through — we drop
    // only what we can confirm is too small.
    const eligible = await filterByCompanySize(afterBlacklist);

    // Cheap-model triage — rejects obvious mismatches (seniority/role/location,
    // never pay) before the expensive scoring call. Fails open per job.
    const triagePassed: typeof eligible = [];
    const triageRejected: Array<{ raw: typeof eligible[number]; reason: string }> = [];
    const TRIAGE_CONCURRENCY = 8;
    for (let i = 0; i < eligible.length; i += TRIAGE_CONCURRENCY) {
      const chunk = eligible.slice(i, i + TRIAGE_CONCURRENCY);
      const verdicts = await Promise.all(chunk.map(raw =>
        triageJob({
          company: raw.company,
          role: raw.role,
          location: raw.location ?? null,
          jdText: raw.jdText,
          profile: { seniorityLevel: settings.profile.seniorityLevel, targetRoles: settings.profile.targetRoles },
          model: settings.ai.triageModel,
        }).then(v => ({ raw, v }))
      ));
      for (const { raw, v } of verdicts) {
        if (v.pass) triagePassed.push(raw);
        else triageRejected.push({ raw, reason: v.reason });
      }
    }

    // Persist triage rejects as SKIPPED (keeps cross-run dedupe working) —
    // minimal rows, no pitch/salary, ~1/50th the LLM cost of a full score.
    for (const { raw, reason } of triageRejected) {
      await prisma.job.create({
        data: {
          source: raw.source,
          company: raw.company,
          role: raw.role,
          jdText: raw.jdText,
          applyUrl: raw.applyUrl,
          location: raw.location,
          jobProviderId: raw.jobProviderId,
          sourcePostUrl: raw.sourcePostUrl,
          dedupeKey: dedupeKey(raw.company, raw.role, raw.location),
          applyType: raw.applyType,
          sourcePostAuthorUrl: raw.sourcePostAuthorUrl,
          sourcePostAuthorName: raw.sourcePostAuthorName,
          externalJobId: raw.externalJobId,
          postedAt: raw.postedAt,
          aiReason: `Triage (cheap-model pre-filter): ${reason}`,
          appStage: "SKIPPED",
        },
      }).catch(e => console.error(`[discover] persisting triage reject failed:`, e));
    }

    console.log(`[discover] triage: ${triagePassed.length} passed, ${triageRejected.length} rejected; scoring survivors (concurrency ${SCORE_CONCURRENCY})`);

    // Full scoring for triage survivors. Run in small parallel chunks for speed.
    const scored: Array<{ raw: typeof eligible[number]; result: Awaited<ReturnType<typeof scoreJob>> }> = [];
    for (let i = 0; i < triagePassed.length; i += SCORE_CONCURRENCY) {
      const chunk = triagePassed.slice(i, i + SCORE_CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map(raw => scoreJob({
          jdText: raw.jdText,
          company: raw.company,
          role: raw.role,
          sourceSalary: raw.sourceSalary,
          relevanceThreshold: settings.search.relevanceThreshold,
          minSalaryAmount:    settings.search.minSalaryAmount,
          minSalaryCurrency:  settings.search.minSalaryCurrency,
          strictSalary:       settings.search.strictSalary,
          profile:            settings.profile,
        }).then(result => ({ raw, result })))
      );
      for (const r of results) {
        if (r.status === "fulfilled") scored.push(r.value);
        else console.error(`[discover] scoring failed:`, r.reason);
      }
    }

    // Broken AI provider key/endpoint turns every job into {score:0,
    // skipReason:"scoring_failed"} — a silent mass-skip. Alert the owner once when
    // it's clearly systemic (not just one flaky generation). Jobs are still
    // persisted below so nothing is lost once the key is fixed and discovery re-runs.
    const scoringFailed = scored.filter(s => s.result.skipReason === "scoring_failed").length;
    if (scored.length >= 5 && scoringFailed / scored.length > 0.6) {
      try {
        await sendScoringFailureAlert(scoringFailed, scored.length);
      } catch (e) {
        console.error("[discover] scoring-failure alert email failed:", e);
      }
    }

    // Persist
    const toEmail: Job[] = [];
    // Friend digest pool — owner-passing jobs PLUS jobs skipped ONLY for salary
    // (skipCategory "salary"). Those are fine roles that just pay below the
    // owner's floor; each friend's own floor is applied in sendFriendDigest.
    // Salary-only skips need a confirmed figure (salaryAnnualBase) so a friend's
    // floor can actually be checked; owner-passing jobs may have unknown salary.
    const friendPool: Job[] = [];
    for (const { raw, result } of scored) {
      const appStage: AppStage = result.skipReason ? "SKIPPED" : "NEW";
      const normalized = await normalizeSalary(result.salary, settings.search.baseCurrency).catch(() => null);

      const job = await prisma.job.create({
        data: {
          source: raw.source,
          company: raw.company,
          role: raw.role,
          jdText: raw.jdText,
          applyUrl: raw.applyUrl,
          location: raw.location,
          jobProviderId: raw.jobProviderId,
          sourcePostUrl: raw.sourcePostUrl,
          dedupeKey: dedupeKey(raw.company, raw.role, raw.location),
          applyType: raw.applyType,
          sourcePostAuthorUrl: raw.sourcePostAuthorUrl,
          sourcePostAuthorName: raw.sourcePostAuthorName,
          externalJobId: raw.externalJobId,
          postedAt: raw.postedAt,

          aiScore: result.score,
          aiReason: result.reason,
          tailoredPitch: result.tailoredPitch,
          needsTailoring: result.needsTailoring,
          tailoringSuggestions: result.tailoringSuggestions,
          appStage,

          salaryMin: result.salary.min ?? null,
          salaryMax: result.salary.max ?? null,
          salaryCurrency: result.salary.currency ?? null,
          salaryPeriod: result.salary.period
            ? (result.salary.period.toUpperCase() as SalaryPeriod)
            : null,
          salaryBasis: result.salary.basis
            ? (result.salary.basis.toUpperCase() as SalaryBasis)
            : null,
          salaryConfidence: result.salary.confidence
            ? (result.salary.confidence.toUpperCase() as SalaryConfidence)
            : null,
          salaryAnnualBase: normalized?.annualBase ?? null,
          salaryFlagReason: result.salaryFlagReason ?? null,
        },
      });

      if (appStage === "NEW") {
        toEmail.push(job);
        friendPool.push(job);
        // FULLY AUTOMATIC: auto-approve and kick off outreach immediately.
        await prisma.job.update({ where: { id: job.id }, data: { appStage: "APPROVED", approvedAt: new Date() } });
        await enqueueOutreach({ ...job, appStage: "APPROVED" }).catch(e =>
          console.error(`[discover] auto-enqueue failed for ${job.id}:`, e));
      } else if (result.skipCategory === "salary" && job.salaryAnnualBase !== null) {
        friendPool.push(job);
      }
    }

    console.log(`[discover] persisted ${scored.length} jobs, ${toEmail.length} for digest`);

    // Send digest — headed by the Apply Today shortlist ranked across the whole
    // open board (pinned first, then composite priority), not just today's finds.
    if (toEmail.length > 0) {
      const openBoard = await prisma.job.findMany({
        where: { appStage: { in: ["NEW", "APPROVED", "OUTREACH"] }, closedAt: null },
      });
      const topPicks = openBoard
        .map(j => ({ job: j, score: computePriority(j).score }))
        .sort((a, b) => (a.job.pinned !== b.job.pinned) ? (a.job.pinned ? -1 : 1) : b.score - a.score)
        .slice(0, 5)
        .map(x => x.job);
      // Isolate SMTP failures — an unwrapped throw here aborts the friend digests,
      // staleness sweep, and webhook pruning that follow.
      try {
        await sendDailyDigest(toEmail, topPicks);
        console.log(`[discover] digest sent with ${toEmail.length} jobs + ${topPicks.length} top picks`);
      } catch (e) {
        console.error("[discover] daily digest failed:", e);
      }
    }

    // Friend digests are independent of the owner's digest: they draw from the
    // wider friendPool, so friends still get mail on days when nothing beats
    // the owner's floor.
    if (friendPool.length > 0) {
      console.log(`[discover] friend pool: ${friendPool.length} jobs (${friendPool.length - toEmail.length} salary-only skips)`);
      await Promise.all(
        config.friendDigest.recipients.map(recipient =>
          sendFriendDigest(friendPool, recipient).catch(e =>
            console.error(`[discover] friend digest failed for ${recipient.email}:`, e))
        )
      );
    }

    // Weekly analytics report — first discover run of an IST Monday. Gated by
    // ops.lastWeeklyReportAt so re-runs and multiple daily runs don't double-send.
    try {
      const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
      const last = settings.ops.lastWeeklyReportAt ? new Date(settings.ops.lastWeeklyReportAt) : null;
      const daysSince = last ? (Date.now() - last.getTime()) / 86_400_000 : Infinity;
      if (istNow.getUTCDay() === 1 && daysSince > 6) {
        const { computeAnalytics } = await import("@/analytics/aggregate");
        const { sendWeeklyReport } = await import("@/email/weekly-report");
        await sendWeeklyReport(await computeAnalytics());
        await updateSettings({ ops: { lastWeeklyReportAt: new Date().toISOString() } });
        console.log("[discover] weekly report sent");
      }
    } catch (e) {
      console.error("[discover] weekly report failed:", e);
    }

    // Auto-tailor resumes for this run's needsTailoring jobs (they were just
    // auto-approved above). Inline because this route has the time budget
    // (maxDuration 300); /api/cron/tailor catches anything left over.
    const tailored = await sweepPendingTailoring(3).catch(e => {
      console.error("[discover] tailoring sweep failed:", e);
      return 0;
    });

    // Staleness sweep — soft-close jobs that went nowhere (backlog #23).
    const swept = await sweepStaleJobs().catch(() => ({ closedNew: 0, closedApproved: 0 }));

    // Prune old webhook dedup rows — only needed during the retry window;
    // keeping them forever bloats the table and slows dedup lookups.
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const { count: prunedWebhooks } = await prisma.webhookEvent
      .deleteMany({ where: { processedAt: { lt: cutoff } } })
      .catch(() => ({ count: 0 }));

    return {
      ok: true,
      fetched: rawJobs.length,
      eligible: eligible.length,
      scored: scored.length,
      emailed: toEmail.length,
      friendPool: friendPool.length,
      tailored,
      staleClosed: swept.closedNew + swept.closedApproved,
      prunedWebhooks,
    };
  }
}

// cron-job.org / browsers can hit GET; same Bearer auth (middleware).
export async function GET() { return POST(); }
