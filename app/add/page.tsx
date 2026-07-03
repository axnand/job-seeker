import { redirect } from "next/navigation";
import { Plus, Sparkles, Wand2, Gauge, Users, TriangleAlert, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { scoreJob } from "@/scoring/ai-scorer";
import { normalizeSalary } from "@/salary/normalize";
import { dedupeKey } from "@/sources/normalize";
import { extractPost } from "@/sources/linkedin-posts";
import { resolveJobId } from "@/sources/job-id";
import { enqueueOutreach } from "@/outreach/enqueue";
import { getSettings } from "@/lib/settings";
import type { AppStage, ApplyType, SalaryBasis, SalaryConfidence, SalaryPeriod } from "@prisma/client";

// Mirrors src/sources/dedupe.ts: a same-key job blocks a re-add while it's
// still being acted on, or was created recently enough to be the same posting.
const ACTIVE_STAGES: AppStage[] = ["NEW", "APPROVED", "OUTREACH", "REPLIED", "APPLIED", "INTERVIEWING", "OFFER"];
const RE_ADMIT_AFTER_DAYS = 30;

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

  // Dedupe BEFORE scoring: an already-tracked job would otherwise be created
  // again, re-scored (duplicate LLM spend), auto-approved, and re-outreached.
  const key = dedupeKey(company, role, undefined);
  const reAdmitCutoff = new Date(Date.now() - RE_ADMIT_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const existing = await prisma.job.findFirst({
    where: {
      dedupeKey: key,
      OR: [{ appStage: { in: ACTIVE_STAGES } }, { createdAt: { gte: reAdmitCutoff } }],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (existing) redirect(`/add?already=${existing.id}`);

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
      dedupeKey: key,
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

const FEATURES = [
  { icon: Wand2,    title: "Auto-parse",     desc: "Extracts company, role, requirements, and the apply link from raw post text." },
  { icon: Gauge,    title: "Smart scoring",  desc: "Ranked 0–100 against your resume, target roles, industry, and salary floor." },
  { icon: Users,    title: "Referral-ready", desc: "Finds people at the company and drafts DMs that hand over the exact job ID." },
];

export default async function AddJobPage({
  searchParams,
}: {
  searchParams: Promise<{ already?: string }>;
}) {
  const { already } = await searchParams;
  const existing = already
    ? await prisma.job.findUnique({
        where: { id: already },
        select: { id: true, company: true, role: true, appStage: true },
      })
    : null;

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <PageHeader title="Add job" subtitle="Paste a post or a job URL — we handle the rest" icon={<Plus className="size-4" />} />

      <div className="flex-1 overflow-y-auto scrollbar-slim">
        <div className="mx-auto w-full max-w-2xl px-6 py-10 space-y-6">

          {/* Already-tracked notice — dedupe hit, nothing was created */}
          {existing && (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <TriangleAlert className="size-4 shrink-0 text-amber-600 mt-0.5" />
              <div className="min-w-0 text-sm text-amber-800">
                <p className="font-semibold">Already tracked — nothing was added.</p>
                <p className="text-amber-700 mt-0.5">
                  {existing.company} · {existing.role} is on the board (stage: {existing.appStage.toLowerCase()}).{" "}
                  <a href={`/jobs/${existing.id}`} className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2 hover:text-amber-900">
                    View job <ExternalLink className="size-3" />
                  </a>
                </p>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold tracking-tight text-zinc-900">Add a new job</h2>
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
                className="w-full px-5 py-4 text-sm font-mono resize-none outline-none focus:ring-2 focus:ring-inset focus:ring-ring/40 placeholder:text-zinc-400 placeholder:font-sans bg-white"
                required
              />

              {/* Mode selector */}
              <div className="border-t border-zinc-100 bg-white px-5 py-3 space-y-2">
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input type="radio" name="mode" value="referral" defaultChecked className="mt-0.5 accent-indigo-600" />
                  <span>
                    <span className="block text-sm font-medium text-zinc-900">Find referrals</span>
                    <span className="block text-xs text-zinc-500">Search people at the company and draft referral DMs (with the job ID).</span>
                  </span>
                </label>
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input type="radio" name="mode" value="notify" className="mt-0.5 accent-indigo-600" />
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
                  className="inline-flex items-center gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium px-4 py-2 rounded-lg shadow-sm transition-colors"
                >
                  <Sparkles className="size-4" /> Score &amp; add
                </button>
              </div>
            </div>
          </form>

          {/* Feature cards */}
          <div className="grid grid-cols-3 gap-3">
            {FEATURES.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="bg-white border border-zinc-200 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="flex size-6 items-center justify-center rounded-md bg-indigo-50 text-primary">
                    <Icon className="size-3.5" />
                  </span>
                  <p className="text-sm font-semibold text-zinc-900">{title}</p>
                </div>
                <p className="text-xs text-zinc-500 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
