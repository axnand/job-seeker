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
import { getSettings } from "@/lib/settings";
import { config } from "@/config";
import type { AppStage, SalaryBasis, SalaryConfidence, SalaryPeriod } from "@prisma/client";

const BATCH_SIZE = 35; // LLM calls per invocation — gpt-4o-mini is cheap; stays under Vercel 60s

// Obvious non-engineering titles — dropped before the LLM to save calls + budget.
const NON_ENG = /\b(sales|account executive|recruiter|talent|copywriter|content writer|freelance writer|marketing|seo|designer|data (entry|analyst)|customer (support|success)|virtual assistant|teacher|tutor|nurse|driver|accountant|hr\b|business development|bdr|sdr)\b/i;

export async function POST() {
  try {
    const [rawJobs, settings] = await Promise.all([discoverJobs(), getSettings()]);
    console.log(`[discover] ${rawJobs.length} fresh jobs after dedup`);

    const now = new Date();
    const maxPostedAge = config.staleness.noNewOutreachAfterDays * 24 * 60 * 60 * 1000;

    // Drop stale postings + obvious non-engineering roles before scoring
    const eligible = rawJobs.filter(job => {
      if (NON_ENG.test(job.role)) return false;
      if (!job.postedAt) return true;
      return now.getTime() - job.postedAt.getTime() < maxPostedAge;
    });

    // Prioritise India-native sources (LinkedIn/Adzuna) over generic remote boards
    const SOURCE_PRIORITY: Record<string, number> = {
      LINKEDIN_JOB: 0, ATS_WATCHLIST: 1, ADZUNA: 2, JSEARCH: 3, REMOTIVE: 4, REMOTEOK: 5, MANUAL: 0, LINKEDIN_POST: 1,
    };
    eligible.sort((a, b) => (SOURCE_PRIORITY[a.source] ?? 9) - (SOURCE_PRIORITY[b.source] ?? 9));

    const batch = eligible.slice(0, BATCH_SIZE);
    const scored = [];

    for (const raw of batch) {
      try {
        const result = await scoreJob({
          jdText: raw.jdText,
          company: raw.company,
          role: raw.role,
          sourceSalary: raw.sourceSalary,
          relevanceThreshold: settings.search.relevanceThreshold,
          minSalaryAmount:    settings.search.minSalaryAmount,
          minSalaryCurrency:  settings.search.minSalaryCurrency,
          strictSalary:       settings.search.strictSalary,
        });

        scored.push({ raw, result });
      } catch (err) {
        console.error(`[discover] scoring failed for ${raw.company} - ${raw.role}:`, err);
      }
    }

    // Persist
    const toEmail = [];
    for (const { raw, result } of scored) {
      const appStage: AppStage = result.skipReason ? "SKIPPED" : "NEW";
      const normalized = await normalizeSalary(result.salary).catch(() => null);

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

      if (appStage === "NEW") toEmail.push(job);
    }

    console.log(`[discover] persisted ${scored.length} jobs, ${toEmail.length} for digest`);

    // Send digest
    if (toEmail.length > 0) {
      await sendDailyDigest(toEmail);
      console.log(`[discover] digest sent with ${toEmail.length} jobs`);
    }

    return NextResponse.json({
      ok: true,
      fetched: rawJobs.length,
      scored: scored.length,
      emailed: toEmail.length,
      remaining: eligible.length - batch.length,
    });
  } catch (err) {
    console.error("[discover] fatal error:", err);
    return NextResponse.json(
      { ok: false, error: String(err) },
      { status: 500 }
    );
  }
}
