/**
 * /add — Paste a job URL or raw JD text.
 * Layered fetch: ATS JSON API → Jina reader → owner pastes text directly.
 * Phase 3 full implementation; this page gives the UI shell + manual-paste path.
 */

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { scoreJob } from "@/scoring/ai-scorer";
import { normalizeSalary } from "@/salary/normalize";
import { dedupeKey } from "@/sources/normalize";
import type { SalaryBasis, SalaryConfidence, SalaryPeriod } from "@prisma/client";

async function addJob(formData: FormData) {
  "use server";

  const input = (formData.get("input") as string ?? "").trim();
  if (!input) return;

  let jdText = "";
  let applyUrl = "";
  let company = "Unknown";
  let role = "Unknown";

  const isUrl = input.startsWith("http");

  if (isUrl) {
    // Layered fetch: Jina reader
    applyUrl = input;
    try {
      const jinaRes = await fetch(`https://r.jina.ai/${encodeURIComponent(input)}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (jinaRes.ok) jdText = await jinaRes.text();
    } catch {
      jdText = "";
    }
    if (!jdText) jdText = `[JD fetch failed — URL: ${input}]`;
  } else {
    jdText = input;
  }

  // Score
  const result = await scoreJob({ jdText, company, role }).catch(() => null);
  if (!result) redirect("/");

  const normalized = await normalizeSalary(result.salary).catch(() => null);

  const job = await prisma.job.create({
    data: {
      source: "MANUAL",
      company,
      role,
      jdText,
      applyUrl,
      dedupeKey: dedupeKey(company, role, undefined),
      applyType: "MANUAL_NOTIFY",
      aiScore: result.score,
      aiReason: result.reason,
      tailoredPitch: result.tailoredPitch,
      appStage: result.skipReason ? "SKIPPED" : "NEW",
      salaryMin: result.salary.min ?? null,
      salaryMax: result.salary.max ?? null,
      salaryCurrency: result.salary.currency ?? null,
      salaryPeriod: result.salary.period ? (result.salary.period.toUpperCase() as SalaryPeriod) : null,
      salaryBasis: result.salary.basis ? (result.salary.basis.toUpperCase() as SalaryBasis) : null,
      salaryConfidence: result.salary.confidence ? (result.salary.confidence.toUpperCase() as SalaryConfidence) : null,
      salaryAnnualBase: normalized?.annualBase ?? null,
      salaryFlagReason: result.salaryFlagReason ?? null,
    },
  });

  redirect(`/jobs/${job.id}`);
}

export default function AddJobPage() {
  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Add a Job</h1>
      <p className="text-gray-500 text-sm mb-6">
        Paste a job URL (fetched automatically) or raw JD text. The system scores it and creates a job record.
      </p>
      <form action={addJob} className="bg-white border border-gray-200 rounded-xl p-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Job URL or JD text
        </label>
        <textarea
          name="input"
          rows={10}
          placeholder="https://boards.greenhouse.io/company/jobs/12345&#10;— or —&#10;Paste the full job description here..."
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-500"
          required
        />
        <button
          type="submit"
          className="mt-4 bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg text-sm font-medium"
        >
          Score & add →
        </button>
      </form>
    </div>
  );
}
