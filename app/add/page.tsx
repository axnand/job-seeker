import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { scoreJob } from "@/scoring/ai-scorer";
import { normalizeSalary } from "@/salary/normalize";
import { dedupeKey } from "@/sources/normalize";
import { extractPost } from "@/sources/linkedin-posts";
import { resolveJobId } from "@/sources/job-id";
import { enqueueOutreach } from "@/outreach/enqueue";
import { getSettings } from "@/lib/settings";
import type { ApplyType, SalaryBasis, SalaryConfidence, SalaryPeriod } from "@prisma/client";

const URL_RE = /https?:\/\/[^\s)\]<>"']+/i;

async function addJob(formData: FormData) {
  "use server";
  const input = (formData.get("input") as string ?? "").trim();
  if (!input) return;
  // Default to the referral flow ("do the rest"); "notify" = just track it.
  const referral = (formData.get("mode") as string) !== "notify";

  const settings = await getSettings();
  let jdText = "";
  let applyUrl = "";
  let company = "Unknown";
  let role = "Software Engineer";

  if (input.startsWith("http")) {
    // A bare URL: fetch the page text so we have something to extract + score.
    applyUrl = input;
    try {
      const r = await fetch(`https://r.jina.ai/${encodeURIComponent(input)}`, { signal: AbortSignal.timeout(15_000) });
      if (r.ok) jdText = await r.text();
    } catch { /* ignore */ }
    if (!jdText) jdText = `[JD fetch failed — URL: ${input}]`;
  } else {
    jdText = input;
  }

  // Pull structured fields out of the pasted text (company, role, apply link).
  const ex = await extractPost(jdText).catch(() => null);
  if (ex) {
    if (ex.company) company = ex.company;
    if (ex.role) role = ex.role;
    if (!applyUrl) applyUrl = ex.applyUrl ?? jdText.match(URL_RE)?.[0] ?? "";
    const tidied = [ex.extractedJd, ex.requirements].filter(Boolean).join("\n\n");
    if (tidied && !input.startsWith("http")) jdText = tidied;
  }

  // Follow the apply link → requisition/job ID for the referral DM (+ canonical URL).
  let externalJobId: string | undefined;
  if (applyUrl) {
    const resolved = await resolveJobId(applyUrl).catch(() => null);
    if (resolved) {
      externalJobId = resolved.jobId ?? undefined;
      applyUrl = resolved.resolvedUrl;
    }
  }

  const result = await scoreJob({
    jdText, company, role,
    relevanceThreshold: settings.search.relevanceThreshold,
    minSalaryAmount:    settings.search.minSalaryAmount,
    minSalaryCurrency:  settings.search.minSalaryCurrency,
    strictSalary:       settings.search.strictSalary,
    profile:            settings.profile,
  }).catch(() => null);
  if (!result) redirect("/");

  const normalized = await normalizeSalary(result.salary, settings.search.baseCurrency).catch(() => null);
  const applyType: ApplyType = referral ? "REFERRAL_FIRST" : "MANUAL_NOTIFY";

  const job = await prisma.job.create({
    data: {
      source: "MANUAL", company, role, jdText, applyUrl, externalJobId,
      dedupeKey: dedupeKey(company, role, undefined),
      applyType,
      // Manually added = intentionally chosen, so we don't auto-skip on a low
      // score; we surface the score's reasoning as a note instead.
      appStage: "NEW",
      appStageNote: result.skipReason ?? null,
      aiScore: result.score, aiReason: result.reason, tailoredPitch: result.tailoredPitch,
      needsTailoring: result.needsTailoring, tailoringSuggestions: result.tailoringSuggestions,
      salaryMin: result.salary.min ?? null, salaryMax: result.salary.max ?? null,
      salaryCurrency: result.salary.currency ?? null,
      salaryPeriod: result.salary.period ? (result.salary.period.toUpperCase() as SalaryPeriod) : null,
      salaryBasis: result.salary.basis ? (result.salary.basis.toUpperCase() as SalaryBasis) : null,
      salaryConfidence: result.salary.confidence ? (result.salary.confidence.toUpperCase() as SalaryConfidence) : null,
      salaryAnnualBase: normalized?.annualBase ?? null,
      salaryFlagReason: result.salaryFlagReason ?? null,
    },
  });

  // Do the rest: approve + kick off outreach (referral → company people-search,
  // notify → email yourself the apply link). Mirrors the automatic discover flow.
  await prisma.job.update({ where: { id: job.id }, data: { appStage: "APPROVED", approvedAt: new Date() } });
  await enqueueOutreach({ ...job, appStage: "APPROVED" }).catch((e) =>
    console.error(`[add] enqueue failed for ${job.id}:`, e));

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
            Paste a job post you saw anywhere — we extract the company &amp; role, grab the job ID from the apply link, and line up referrals.
          </p>
        </div>

        {/* Input card */}
        <form action={addJob}>
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
            <textarea
              name="input"
              rows={10}
              placeholder="Paste the full job post text here…&#10;or a Greenhouse / Lever / Ashby URL"
              className="w-full px-5 py-4 text-sm font-mono resize-none focus:outline-none placeholder:text-zinc-400 placeholder:font-sans bg-white"
              required
            />

            {/* Mode selector */}
            <div className="border-t border-zinc-100 bg-white px-5 py-3 space-y-2">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="radio" name="mode" value="referral" defaultChecked className="mt-0.5 accent-zinc-900" />
                <span>
                  <span className="block text-sm font-medium text-zinc-900">Find referrals</span>
                  <span className="block text-xs text-zinc-500">Search people at the company and draft referral DMs (with the job ID).</span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="radio" name="mode" value="notify" className="mt-0.5 accent-zinc-900" />
                <span>
                  <span className="block text-sm font-medium text-zinc-900">Just track it</span>
                  <span className="block text-xs text-zinc-500">Score &amp; save only — email me the apply link so I can apply myself.</span>
                </span>
              </label>
            </div>

            <div className="border-t border-zinc-100 bg-zinc-50 px-5 py-3 flex items-center justify-between">
              <p className="text-xs text-zinc-400">Greenhouse · Lever · Ashby · Jina reader fallback</p>
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
            { icon: "✦", title: "Auto-Parse",    desc: "Extracts company, role, requirements, and the apply link from raw post text." },
            { icon: "◈", title: "Smart Scoring",  desc: "Ranked 0–100 against your resume, target roles, industry, and salary floor." },
            { icon: "⊞", title: "Referral-Ready", desc: "Finds people at the company and drafts DMs that hand over the exact job ID." },
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
