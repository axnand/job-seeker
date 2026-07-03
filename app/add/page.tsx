import { redirect } from "next/navigation";
import { Plus, Sparkles, Wand2, Gauge, Users, TriangleAlert, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { scoreJob } from "@/scoring/ai-scorer";
import { normalizeSalary } from "@/salary/normalize";
import { dedupeKey } from "@/sources/normalize";
import { extractPost } from "@/sources/linkedin-posts";
import { ingestJobUrl } from "@/sources/url-ingest";
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
    // A bare URL: LinkedIn jobs go through authenticated Unipile; everything
    // else via reader proxy → direct fetch. Refuse to create a junk entry when
    // nothing usable came back — tell the owner to paste the text instead.
    applyUrl = input;
    const page = await ingestJobUrl(input).catch(() => null);
    if (!page) redirect("/add?error=fetch");
    jdText = page.text;
    if (page.company) company = page.company;
    if (page.role) role = page.role;
    if (page.applyUrl) applyUrl = page.applyUrl;
  } else {
    jdText = input;
  }

  // Pull structured fields out of the text (company, role, apply link) unless
  // the URL ingest already returned them structured (Unipile).
  if (company === "Unknown" || !applyUrl) {
    const ex = await extractPost(jdText).catch(() => null);
    if (ex) {
      if (company === "Unknown" && ex.company) company = ex.company;
      if (role === "Software Engineer" && ex.role) role = ex.role;
      if (!applyUrl) applyUrl = ex.applyUrl ?? jdText.match(URL_RE)?.[0] ?? "";
      const tidied = [ex.extractedJd, ex.requirements].filter(Boolean).join("\n\n");
      if (tidied && !input.startsWith("http")) jdText = tidied;
    }
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
  searchParams: Promise<{ already?: string; error?: string }>;
}) {
  const { already, error } = await searchParams;
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
        <div className="mx-auto w-full max-w-6xl px-6 py-10 lg:px-10">

          <div className="mb-6 space-y-1.5">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">Add a new job</h2>
            <p className="text-sm text-muted-foreground">
              Paste a job post you saw anywhere — we extract the company &amp; role, grab the job ID from the apply link, and line up referrals.
            </p>
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">

            {/* Main column — input + mode */}
            <form action={addJob} className="min-w-0">
              <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
                <textarea
                  name="input"
                  rows={16}
                  placeholder="Paste the full job post text here…&#10;or a Greenhouse / Lever / Ashby URL"
                  className="w-full px-5 py-4 text-sm font-mono resize-none outline-none focus:ring-2 focus:ring-inset focus:ring-ring/40 placeholder:text-muted-foreground placeholder:font-sans bg-card"
                  required
                />

                {/* Mode selector */}
                <div className="border-t border-border bg-card px-5 py-3 grid gap-2 sm:grid-cols-2">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input type="radio" name="mode" value="referral" defaultChecked className="mt-0.5 accent-indigo-600" />
                    <span>
                      <span className="block text-sm font-medium text-foreground">Find referrals</span>
                      <span className="block text-xs text-muted-foreground">Search people at the company and draft referral DMs (with the job ID).</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input type="radio" name="mode" value="notify" className="mt-0.5 accent-indigo-600" />
                    <span>
                      <span className="block text-sm font-medium text-foreground">Just track it</span>
                      <span className="block text-xs text-muted-foreground">Score &amp; save only — email me the apply link so I can apply myself.</span>
                    </span>
                  </label>
                </div>

                <div className="border-t border-border bg-muted/50 px-5 py-3 flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">Greenhouse · Lever · Ashby · Jina reader fallback</p>
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium px-4 py-2 rounded-lg shadow-sm transition-colors"
                  >
                    <Sparkles className="size-4" /> Score &amp; add
                  </button>
                </div>
              </div>
            </form>

            {/* Right rail — status banners + what happens next */}
            <aside className="space-y-4">

              {/* URL fetch failed — nothing was created */}
              {error === "fetch" && (
                <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10 px-4 py-3">
                  <TriangleAlert className="size-4 shrink-0 text-red-600 dark:text-red-300 mt-0.5" />
                  <div className="min-w-0 text-sm text-red-800 dark:text-red-300">
                    <p className="font-semibold">Couldn&apos;t read that URL — nothing was added.</p>
                    <p className="text-red-700 dark:text-red-300 mt-0.5">
                      The page blocked automated readers (common for LinkedIn posts). Open it, copy the
                      job text, and paste it here instead — everything else works the same.
                    </p>
                  </div>
                </div>
              )}

              {/* Already-tracked notice — dedupe hit, nothing was created */}
              {existing && (
                <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10 px-4 py-3">
                  <TriangleAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-300 mt-0.5" />
                  <div className="min-w-0 text-sm text-amber-800 dark:text-amber-300">
                    <p className="font-semibold">Already tracked — nothing was added.</p>
                    <p className="text-amber-700 dark:text-amber-300 mt-0.5">
                      {existing.company} · {existing.role} is on the board (stage: {existing.appStage.toLowerCase()}).{" "}
                      <a href={`/jobs/${existing.id}`} className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-300">
                        View job <ExternalLink className="size-3" />
                      </a>
                    </p>
                  </div>
                </div>
              )}

              <p className="px-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">What happens next</p>
              {FEATURES.map(({ icon: Icon, title, desc }) => (
                <div key={title} className="bg-card border border-border rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="flex size-6 items-center justify-center rounded-md bg-indigo-50 dark:bg-indigo-500/10 text-primary">
                      <Icon className="size-3.5" />
                    </span>
                    <p className="text-sm font-semibold text-foreground">{title}</p>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
                </div>
              ))}
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
