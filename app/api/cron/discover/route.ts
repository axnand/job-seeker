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
import { normalizeSalary } from "@/salary/normalize";
import { dedupeKey } from "@/sources/normalize";
import { sendDailyDigest } from "@/email/digest";
import { enqueueOutreach } from "@/outreach/enqueue";
import { getSettings } from "@/lib/settings";
import { withCronLock } from "@/lib/cron-lock";
import { sweepStaleJobs } from "@/status/staleness";
import type { AppStage, SalaryBasis, SalaryConfidence, SalaryPeriod } from "@prisma/client";

const SCORE_CONCURRENCY = 6; // parallel LLM calls — fast without hammering rate limits

// Obvious non-engineering titles — dropped before the LLM to save calls + budget.
const NON_ENG = /\b(sales|account executive|recruiter|talent|copywriter|content writer|freelance writer|marketing|seo|designer|data (entry|analyst)|customer (support|success)|virtual assistant|teacher|tutor|nurse|driver|accountant|hr\b|business development|bdr|sdr)\b/i;

export const maxDuration = 300; // allow long runs on Vercel Pro; hobby caps at 60s

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

    // Drop old postings + obvious non-engineering roles before scoring
    const eligible = rawJobs.filter(job => {
      if (NON_ENG.test(job.role)) return false;
      if (!job.postedAt) return true;                       // unknown age — keep
      return now.getTime() - job.postedAt.getTime() < maxPostedAge;
    });

    console.log(`[discover] scoring all ${eligible.length} eligible jobs (concurrency ${SCORE_CONCURRENCY})`);

    // Score EVERYTHING — no cap. Run in small parallel chunks for speed.
    const scored: Array<{ raw: typeof eligible[number]; result: Awaited<ReturnType<typeof scoreJob>> }> = [];
    for (let i = 0; i < eligible.length; i += SCORE_CONCURRENCY) {
      const chunk = eligible.slice(i, i + SCORE_CONCURRENCY);
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

    // Persist
    const toEmail = [];
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
        // FULLY AUTOMATIC: auto-approve and kick off outreach immediately.
        await prisma.job.update({ where: { id: job.id }, data: { appStage: "APPROVED", approvedAt: new Date() } });
        await enqueueOutreach({ ...job, appStage: "APPROVED" }).catch(e =>
          console.error(`[discover] auto-enqueue failed for ${job.id}:`, e));
      }
    }

    console.log(`[discover] persisted ${scored.length} jobs, ${toEmail.length} for digest`);

    // Send digest
    if (toEmail.length > 0) {
      await sendDailyDigest(toEmail);
      console.log(`[discover] digest sent with ${toEmail.length} jobs`);
    }

    // Staleness sweep — soft-close jobs that went nowhere (backlog #23).
    const swept = await sweepStaleJobs().catch(() => ({ closedNew: 0, closedApproved: 0 }));

    return {
      ok: true,
      fetched: rawJobs.length,
      eligible: eligible.length,
      scored: scored.length,
      emailed: toEmail.length,
      staleClosed: swept.closedNew + swept.closedApproved,
    };
  }
}

// cron-job.org / browsers can hit GET; same Bearer auth (middleware).
export async function GET() { return POST(); }
