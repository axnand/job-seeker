import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { scoreJob } from "@/scoring/ai-scorer";
import { normalizeSalary } from "@/salary/normalize";
import { dedupeKey } from "@/sources/normalize";
import { getSettings } from "@/lib/settings";
import type { SalaryBasis, SalaryConfidence, SalaryPeriod } from "@prisma/client";

async function addJob(formData: FormData) {
  "use server";
  const input = (formData.get("input") as string ?? "").trim();
  if (!input) return;

  const settings = await getSettings();
  let jdText = "", applyUrl = "";
  const company = "Unknown", role = "Unknown";

  if (input.startsWith("http")) {
    applyUrl = input;
    try {
      const r = await fetch(`https://r.jina.ai/${encodeURIComponent(input)}`, { signal: AbortSignal.timeout(15_000) });
      if (r.ok) jdText = await r.text();
    } catch { /* ignore */ }
    if (!jdText) jdText = `[JD fetch failed — URL: ${input}]`;
  } else {
    jdText = input;
  }

  const result = await scoreJob({
    jdText, company, role,
    relevanceThreshold: settings.search.relevanceThreshold,
    minSalaryAmount:    settings.search.minSalaryAmount,
    minSalaryCurrency:  settings.search.minSalaryCurrency,
    strictSalary:       settings.search.strictSalary,
  }).catch(() => null);
  if (!result) redirect("/");

  const normalized = await normalizeSalary(result.salary).catch(() => null);

  const job = await prisma.job.create({
    data: {
      source: "MANUAL", company, role, jdText, applyUrl,
      dedupeKey: dedupeKey(company, role, undefined),
      applyType: "MANUAL_NOTIFY",
      aiScore: result.score, aiReason: result.reason, tailoredPitch: result.tailoredPitch,
      needsTailoring: result.needsTailoring, tailoringSuggestions: result.tailoringSuggestions,
      appStage: result.skipReason ? "SKIPPED" : "NEW",
      salaryMin: result.salary.min ?? null, salaryMax: result.salary.max ?? null,
      salaryCurrency: result.salary.currency ?? null,
      salaryPeriod: result.salary.period ? (result.salary.period.toUpperCase() as SalaryPeriod) : null,
      salaryBasis: result.salary.basis ? (result.salary.basis.toUpperCase() as SalaryBasis) : null,
      salaryConfidence: result.salary.confidence ? (result.salary.confidence.toUpperCase() as SalaryConfidence) : null,
      salaryAnnualBase: normalized?.annualBase ?? null,
      salaryFlagReason: result.salaryFlagReason ?? null,
    },
  });

  redirect(`/?job=${job.id}`);
}

export default function AddJobPage() {
  return (
    <div className="min-h-[calc(100vh-44px)] bg-zinc-100 flex flex-col items-center justify-start pt-16 px-6">
      <div className="w-full max-w-2xl space-y-8">

        {/* Heading */}
        <div className="text-center space-y-1.5">
          <h1 className="text-2xl font-bold text-zinc-900">Add New Job</h1>
          <p className="text-sm text-zinc-500">
            URLs are fetched automatically. We&apos;ll score them against your preferences immediately.
          </p>
        </div>

        {/* Input card */}
        <form action={addJob}>
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
            <textarea
              name="input"
              rows={10}
              placeholder="Paste a Greenhouse / Lever / Ashby URL or raw JD text here…&#10;(One per line for bulk add)"
              className="w-full px-5 py-4 text-sm font-mono resize-none focus:outline-none placeholder:text-zinc-400 placeholder:font-sans bg-white"
              required
            />
            <div className="border-t border-zinc-100 bg-zinc-50 px-5 py-3 flex items-center justify-between">
              <p className="text-xs text-zinc-400">Greenhouse · Lever · Ashby APIs · Jina reader fallback</p>
              <button
                type="submit"
                className="bg-zinc-900 hover:bg-zinc-800 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
              >
                Score &amp; add →
              </button>
            </div>
          </div>
        </form>

        {/* Feature cards */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { icon: "✦", title: "Auto-Parse",    desc: "Detects ATS type and extracts role, requirements, and salary from the JD automatically." },
            { icon: "◈", title: "Smart Scoring",  desc: "Every job is ranked 0–100 against your resume, target roles, industry, and salary floor." },
            { icon: "⊞", title: "Bulk Intake",    desc: "Paste up to 50 URLs at once — one per line — to process an entire Open Tabs session." },
          ].map(({ icon, title, desc }) => (
            <div key={title} className="bg-white border border-zinc-200 rounded-xl p-4">
              <p className="text-sm font-semibold text-zinc-900 mb-1.5">{icon}  {title}</p>
              <p className="text-xs text-zinc-500 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
