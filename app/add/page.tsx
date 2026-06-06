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
    <div className="min-h-[calc(100vh-48px)] flex flex-col items-center justify-start pt-20 px-6">
      <div className="w-full max-w-2xl space-y-8">
        {/* Heading */}
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold">Add New Job</h1>
          <p className="text-muted-foreground">
            URLs are fetched automatically. We&apos;ll score them against your preferences immediately.
          </p>
        </div>

        {/* Input */}
        <form action={addJob} className="space-y-4">
          <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
            <textarea
              name="input"
              rows={10}
              placeholder="Paste a Greenhouse/Lever/Ashby URL or raw JD text here… (Enter one per line for bulk add)"
              className="w-full px-5 py-4 text-sm font-mono resize-none focus:outline-none placeholder:text-muted-foreground/60 placeholder:font-sans"
              required
            />
            <div className="border-t border-border px-5 py-3 flex justify-end bg-slate-50">
              <span className="text-xs text-muted-foreground">Supports Greenhouse, Lever, Ashby · Jina reader fallback</span>
            </div>
          </div>

          <button
            type="submit"
            className="w-full bg-foreground hover:bg-foreground/90 text-background font-semibold py-3 rounded-xl text-sm transition-colors flex items-center justify-center gap-2"
          >
            Score &amp; add →
          </button>
        </form>

        {/* Feature callouts */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { icon: "✦", title: "Auto-Parse",   desc: "Detects board type and extracts role, requirements, and salary automatically." },
            { icon: "◈", title: "Smart Scoring", desc: "Every job is ranked 0–100 against your target roles, industries, and salary floor." },
            { icon: "⊞", title: "Bulk Intake",   desc: "Add up to 50 URLs at once — one per line — to clear your open tabs in seconds." },
          ].map(({ icon, title, desc }) => (
            <div key={title} className="bg-white border border-border rounded-xl p-4">
              <p className="text-sm font-semibold mb-1">{icon}  {title}</p>
              <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
