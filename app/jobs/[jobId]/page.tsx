import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import type { AppStage } from "@prisma/client";
import { enqueueOutreach } from "@/outreach/enqueue";
import { recomputeOutreachState } from "@/status/outreach-state";
import {
  ArrowLeft,
  CircleDollarSign,
  Sparkles,
  ExternalLink,
  Check,
  X,
  TriangleAlert,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { TailoringSection } from "@/components/tailoring-section";

const PERIOD_LABEL: Record<string, string> = {
  YEAR: "/yr", MONTH: "/mo", HOUR: "/hr",
};

const STAGE_STYLE: Record<string, { dot: string; pill: string }> = {
  NEW:          { dot: "bg-slate-400",   pill: "bg-slate-100 text-slate-600 border-slate-200" },
  APPROVED:     { dot: "bg-blue-500",    pill: "bg-blue-50 text-blue-700 border-blue-200" },
  OUTREACH:     { dot: "bg-indigo-500",  pill: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  REPLIED:      { dot: "bg-emerald-500", pill: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  APPLIED:      { dot: "bg-violet-500",  pill: "bg-violet-50 text-violet-700 border-violet-200" },
  INTERVIEWING: { dot: "bg-amber-500",   pill: "bg-amber-50 text-amber-800 border-amber-200" },
  OFFER:        { dot: "bg-green-500",   pill: "bg-green-50 text-green-800 border-green-200" },
  SKIPPED:      { dot: "bg-slate-300",   pill: "bg-slate-50 text-slate-400 border-slate-200" },
};

// Post-referral milestones the owner drives by hand (used by the pipeline control).
const PIPELINE_STAGES: { stage: AppStage; action: string; label: string }[] = [
  { stage: "REPLIED",      action: "replied",      label: "Replied" },
  { stage: "APPLIED",      action: "applied",      label: "Applied" },
  { stage: "INTERVIEWING", action: "interviewing", label: "Interviewing" },
  { stage: "OFFER",        action: "offer",        label: "Offer" },
];

const SCORE_COLOR = (s: number) =>
  s >= 80 ? "text-emerald-600" : s >= 60 ? "text-amber-600" : "text-slate-500";

// Server Actions run the same logic as POST /api/jobs/action and
// POST /api/outreach/confirm directly against the DB. (They used to self-fetch
// those routes over HTTP, which middleware Basic-Auth 401'd in production —
// the buttons silently no-op'd.)

const STAGE_ACTIONS: Record<string, AppStage> = {
  approve:      "APPROVED",
  skip:         "SKIPPED",
  skipped:      "SKIPPED",
  replied:      "REPLIED",
  outreach:     "OUTREACH",
  restore:      "NEW",
  applied:      "APPLIED",
  interviewing: "INTERVIEWING",
  offer:        "OFFER",
};

async function updateStage(formData: FormData) {
  "use server";
  const jobId  = formData.get("jobId")  as string;
  const action = formData.get("action") as string;
  const note   = (formData.get("note") as string) || null;
  if (!jobId || !action) return;

  const newStage = STAGE_ACTIONS[action.toLowerCase()];
  if (!newStage) return;

  const isRestore = action.toLowerCase() === "restore";
  let job;
  try {
    job = await prisma.job.update({
      where: { id: jobId },
      data: {
        appStage: newStage,
        // Restore wipes the skip-reason; explicit note overrides both directions.
        appStageNote: note ?? (isRestore ? null : undefined),
        ...(newStage === "APPROVED" ? { approvedAt: new Date() } : {}),
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") return; // job gone
    throw err;
  }

  // On approve, kick off the outreach machine (drafts only — nothing sends
  // until the owner confirms).
  if (newStage === "APPROVED") {
    try {
      await enqueueOutreach(job);
    } catch (err) {
      console.error(`[jobs/${jobId}] enqueueOutreach failed:`, err);
    }
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/");
}

async function confirmOutreach(formData: FormData) {
  "use server";
  const threadId = formData.get("threadId") as string;
  const action = formData.get("action") as string; // "send" | "cancel"
  const jobId = formData.get("jobId") as string;
  if (!threadId || !action) return;

  const thread = await prisma.channelThread.findUnique({
    where: { id: threadId },
    select: { id: true, status: true, providerState: true, outreachId: true },
  });
  if (!thread) return;

  const ps = (thread.providerState as Record<string, unknown> | null) ?? {};
  // Only DRAFT threads are confirmable — don't reset an in-flight sequence.
  if (ps.phase !== "DRAFT") return;

  const outreach = thread.outreachId
    ? await prisma.outreach.findUnique({ where: { id: thread.outreachId }, select: { jobId: true } })
    : null;

  if (action === "cancel") {
    await prisma.channelThread.update({
      where: { id: thread.id },
      data: { status: "ARCHIVED", archivedAt: new Date(), archivedReason: "Cancelled by owner", nextActionAt: null },
    });
  } else {
    // Nullish fallbacks mirror the API route: a field the owner explicitly
    // cleared stays cleared; only a missing field falls back to the draft.
    const connectionNote = formData.get("connectionNote") as string | null;
    const firstDm = formData.get("firstDm") as string | null;
    const followup = formData.get("followup") as string | null;
    await prisma.channelThread.update({
      where: { id: thread.id },
      data: {
        status: "PENDING",
        nextActionAt: new Date(),
        providerState: {
          ...ps,
          phase: "QUEUED",
          connectionNote: (connectionNote ?? (ps.connectionNote as string) ?? "").slice(0, 300),
          firstDm: firstDm ?? (ps.firstDm as string) ?? "",
          followup: followup ?? (ps.followup as string) ?? "",
        },
      },
    });
  }
  if (outreach?.jobId) await recomputeOutreachState(outreach.jobId).catch(() => {});

  if (jobId) revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/");
}

const THREAD_PHASE_LABEL: Record<string, string> = {
  DRAFT: "Draft — awaiting your review",
  QUEUED: "Queued — invite sends next tick",
  INVITE_PENDING: "Invite sent — awaiting acceptance",
  CONNECTED: "Connected — DM sends next tick",
  MESSAGED: "Messaged — awaiting reply",
  REPLIED: "Replied",
};

export default async function JobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<{ action?: string }>;
}) {
  const { jobId } = await params;
  const { action } = await searchParams;

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { outreaches: { include: { contact: true } } },
  });
  if (!job) notFound();

  // ChannelThread isn't a Prisma relation on Outreach (just FK columns), so
  // fetch the threads for this job's outreaches and key them by outreachId.
  const threads = job.outreaches.length
    ? await prisma.channelThread.findMany({
        where: { outreachId: { in: job.outreaches.map((o) => o.id) } },
      })
    : [];
  const threadByOutreach = new Map(threads.map((t) => [t.outreachId, t]));

  const salary = job.salaryAnnualBase
    ? new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: job.salaryCurrency ?? "INR",
        maximumFractionDigits: 0,
      }).format(job.salaryAnnualBase) +
      (PERIOD_LABEL[job.salaryPeriod ?? "YEAR"] ?? "/yr") +
      (job.salaryBasis === "ESTIMATED"
        ? ` (est. ${job.salaryConfidence?.toLowerCase() ?? ""})`
        : " (stated)")
    : null;

  const stageStyle = STAGE_STYLE[job.appStage] ?? STAGE_STYLE.NEW;

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <PageHeader title={job.company} subtitle={job.role}>
        <a href="/" className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-600 border border-zinc-200 rounded-lg px-3 h-8 hover:bg-zinc-50 hover:text-zinc-900 transition-colors">
          <ArrowLeft className="size-3.5" /> Board
        </a>
      </PageHeader>

      <div className="flex-1 overflow-y-auto scrollbar-slim">
      <div className="max-w-2xl mx-auto px-6 py-8 space-y-4">

        {/* Hero */}
        <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
          <div className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h1 className="text-xl font-bold text-zinc-900 leading-tight">{job.company}</h1>
                <p className="text-zinc-500 mt-0.5 text-sm">{job.role}</p>
              </div>
              {job.aiScore !== null && (
                <div className="shrink-0 flex flex-col items-center bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-2.5 min-w-[64px]">
                  <span className={`text-2xl font-black leading-none ${SCORE_COLOR(job.aiScore)}`}>
                    {job.aiScore}
                  </span>
                  <span className="text-[10px] text-zinc-400 mt-0.5 font-medium">/ 100</span>
                </div>
              )}
            </div>

            {/* Tags */}
            <div className="flex flex-wrap gap-1.5 mt-4">
              <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border font-medium ${stageStyle.pill}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${stageStyle.dot}`} />
                {job.appStage}
              </span>
              <span className="text-xs px-2.5 py-1 rounded-full border border-zinc-200 bg-zinc-50 text-zinc-600 font-medium">
                {job.source.replace(/_/g, " ")}
              </span>
              <span className="text-xs px-2.5 py-1 rounded-full border border-violet-200 bg-violet-50 text-violet-600 font-medium">
                {job.applyType.replace(/_/g, " ")}
              </span>
              {job.outreachState !== "NONE" && (
                <span className="text-xs px-2.5 py-1 rounded-full border border-sky-200 bg-sky-50 text-sky-600 font-medium">
                  {job.outreachState.replace(/_/g, " ")}
                </span>
              )}
            </div>
          </div>

          {/* Salary + reason */}
          {(salary || job.aiReason) && (
            <div className="border-t border-zinc-100 px-6 py-4 space-y-2 bg-zinc-50/60">
              {salary && (
                <div className="flex items-center gap-2">
                  <CircleDollarSign className="size-3.5 text-emerald-500 shrink-0" />
                  <span className="text-sm font-semibold text-emerald-700">{salary}</span>
                  {job.salaryFlagReason && (
                    <span className="inline-flex items-center gap-1 text-xs text-amber-600 ml-1"><TriangleAlert className="size-3" /> {job.salaryFlagReason.replace(/_/g, " ")}</span>
                  )}
                </div>
              )}
              {job.aiReason && (
                <p className="text-sm text-zinc-500 leading-relaxed">{job.aiReason}</p>
              )}
            </div>
          )}

          {/* AI Pitch */}
          {job.tailoredPitch && (
            <div className="border-t border-zinc-100 px-6 py-4">
              <div className="flex items-center gap-1.5 mb-2">
                <Sparkles className="size-3.5 text-primary" />
                <span className="text-xs font-semibold text-primary uppercase tracking-widest">AI pitch</span>
              </div>
              <p className="text-sm text-zinc-700 leading-relaxed whitespace-pre-line">{job.tailoredPitch}</p>
            </div>
          )}

          {/* Apply link */}
          {job.applyUrl && (
            <div className="border-t border-zinc-100 px-6 py-3">
              <a
                href={job.applyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-indigo-800 font-medium transition-colors"
              >
                Open application
                <ExternalLink className="size-3" />
              </a>
            </div>
          )}
        </div>

        {/* Email action hint */}
        {action && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 flex items-center gap-2">
            <Sparkles className="size-3.5 shrink-0" />
            {action === "approve"
              ? "Review the pitch above, then approve to queue outreach."
              : "Confirm below to skip this job."}
          </div>
        )}

        {/* Take action — NEW */}
        {job.appStage === "NEW" && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-6">
            <h2 className="text-sm font-semibold text-zinc-700 mb-3">Take action</h2>
            <form action={updateStage} className="flex flex-col sm:flex-row gap-2.5 items-stretch sm:items-center">
              <input type="hidden" name="jobId" value={job.id} />
              <input
                type="text"
                name="note"
                placeholder="Optional note…"
                className="flex-1 border border-zinc-200 rounded-lg px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring transition"
              />
              <div className="flex gap-2 shrink-0">
                <button
                  type="submit"
                  name="action"
                  value="approve"
                  className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold transition-colors shadow-sm"
                >
                  <Check className="size-3.5" />
                  Approve
                </button>
                <button
                  type="submit"
                  name="action"
                  value="skip"
                  className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-600 text-sm font-medium transition-colors"
                >
                  <X className="size-3.5" />
                  Skip
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Pipeline stage — advance the job through the post-referral milestones */}
        {["APPROVED", "OUTREACH", "REPLIED", "APPLIED", "INTERVIEWING", "OFFER"].includes(job.appStage) && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-6">
            <h2 className="text-sm font-semibold text-zinc-700 mb-3">Pipeline stage</h2>
            <form action={updateStage} className="space-y-3">
              <input type="hidden" name="jobId" value={job.id} />
              <div className="inline-flex w-full rounded-lg border border-zinc-200 bg-zinc-50 p-0.5">
                {PIPELINE_STAGES.map(({ stage, action, label }) => {
                  const active = job.appStage === stage;
                  return (
                    <button key={stage} type="submit" name="action" value={action} disabled={active}
                      className={`flex-1 text-xs font-medium h-9 rounded-md transition-colors ${active ? "bg-indigo-600 text-white shadow-sm" : "text-zinc-500 hover:text-zinc-900 hover:bg-white disabled:opacity-50"}`}>
                      {label}
                    </button>
                  );
                })}
              </div>
              <button type="submit" name="action" value="skipped"
                className="px-3 py-1.5 rounded-lg border border-zinc-200 bg-zinc-50 hover:bg-zinc-100 text-red-600 text-sm font-medium transition-colors">
                Skip / stop
              </button>
            </form>
          </div>
        )}

        {/* Auto-tailoring — surgical resume edits for this JD */}
        {job.needsTailoring && (
          <TailoringSection
            jobId={job.id}
            tailorLog={job.tailorLog}
            tailoredResumeKey={job.tailoredResumeKey}
          />
        )}

        {/* Outreach — review drafts + track threads */}
        {job.outreaches.length > 0 && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-6">
            <h2 className="text-sm font-semibold text-zinc-700 mb-3">Outreach</h2>
            <div className="space-y-4">
              {job.outreaches.map(o => {
                const thread = threadByOutreach.get(o.id);
                const ps = (thread?.providerState as { phase?: string; connectionNote?: string; firstDm?: string; followup?: string } | null) ?? {};
                const phase = ps.phase ?? "DRAFT";
                const isDraft = phase === "DRAFT" && thread?.status === "PENDING";
                const phaseLabel = thread?.status === "ARCHIVED"
                  ? (thread.archivedReason ?? "Archived")
                  : (THREAD_PHASE_LABEL[phase] ?? phase);

                return (
                  <div key={o.id} className="rounded-xl bg-zinc-50 border border-zinc-100 overflow-hidden">
                    <div className="flex items-center gap-3 p-3">
                      <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center shrink-0 text-xs font-bold text-indigo-600">
                        {o.contact.name?.[0]?.toUpperCase() ?? "?"}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-zinc-800 truncate">{o.contact.name}</p>
                        <p className="text-xs text-zinc-400 truncate">{o.contact.title} · {o.role.toLowerCase()}</p>
                      </div>
                      <a
                        href={o.contact.linkedinUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-auto shrink-0 text-xs text-primary hover:text-indigo-700 font-medium flex items-center gap-1 transition-colors"
                      >
                        LinkedIn
                        <ExternalLink className="size-2.5" />
                      </a>
                    </div>

                    <div className={`px-3 pb-3 ${isDraft ? "" : "pt-0"}`}>
                      <span className="text-[11px] font-medium text-zinc-500">{phaseLabel}</span>
                    </div>

                    {isDraft && thread && (
                      <form action={confirmOutreach} className="border-t border-zinc-200 bg-white p-4 space-y-3">
                        <input type="hidden" name="threadId" value={thread.id} />
                        <input type="hidden" name="jobId" value={job.id} />
                        <p className="text-[11px] text-amber-600 font-medium">Review &amp; edit before anything sends. Nothing goes out until you confirm.</p>
                        <div>
                          <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wide">Connection note (≤300)</label>
                          <textarea name="connectionNote" rows={3} defaultValue={ps.connectionNote ?? ""} maxLength={300}
                            className="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-transparent" />
                        </div>
                        <div>
                          <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wide">First DM (after they accept)</label>
                          <textarea name="firstDm" rows={6} defaultValue={ps.firstDm ?? ""}
                            className="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-transparent" />
                        </div>
                        <div>
                          <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wide">Follow-up (if no reply)</label>
                          <textarea name="followup" rows={3} defaultValue={ps.followup ?? ""}
                            className="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-transparent" />
                        </div>
                        <div className="flex gap-2">
                          <button type="submit" name="action" value="send"
                            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold transition-colors shadow-sm">
                            Confirm &amp; Send
                          </button>
                          <button type="submit" name="action" value="cancel"
                            className="inline-flex items-center justify-center px-4 py-2 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-500 text-sm font-medium transition-colors">
                            Cancel
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* No-targets hint */}
        {job.appStage === "APPROVED" && job.applyType === "REFERRAL_FIRST" && job.outreaches.length === 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            Approved, but no LinkedIn outreach targets were found for this role yet. You can apply directly via the link above.
          </div>
        )}

        {/* Job Description */}
        <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-zinc-100">
            <h2 className="text-sm font-semibold text-zinc-700">Job description</h2>
          </div>
          <div className="px-6 py-4 max-h-[500px] overflow-y-auto scrollbar-slim">
            <pre className="text-sm text-zinc-600 whitespace-pre-wrap font-sans leading-relaxed">
              {job.jdText}
            </pre>
          </div>
        </div>

      </div>
      </div>
    </div>
  );
}
