import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";

const PERIOD_LABEL: Record<string, string> = {
  YEAR: "/yr", MONTH: "/mo", HOUR: "/hr",
};

const STAGE_STYLE: Record<string, { dot: string; pill: string }> = {
  NEW:          { dot: "bg-slate-400",   pill: "bg-slate-100 text-slate-600 border-slate-200" },
  APPROVED:     { dot: "bg-blue-500",    pill: "bg-blue-50 text-blue-700 border-blue-200" },
  SKIPPED:      { dot: "bg-slate-300",   pill: "bg-slate-50 text-slate-400 border-slate-200" },
  APPLIED:      { dot: "bg-violet-500",  pill: "bg-violet-50 text-violet-700 border-violet-200" },
  INTERVIEWING: { dot: "bg-amber-500",   pill: "bg-amber-50 text-amber-700 border-amber-200" },
  OFFER:        { dot: "bg-emerald-500", pill: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  CLOSED:       { dot: "bg-red-400",     pill: "bg-red-50 text-red-600 border-red-200" },
};

const SCORE_COLOR = (s: number) =>
  s >= 80 ? "text-emerald-600" : s >= 60 ? "text-amber-600" : "text-slate-500";

async function updateStage(formData: FormData) {
  "use server";
  const jobId  = formData.get("jobId")  as string;
  const action = formData.get("action") as string;
  const note   = (formData.get("note") as string) || null;
  if (!jobId || !action) return;
  await fetch(
    `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/api/jobs/action`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, action, note }),
    }
  );
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/");
}

async function confirmOutreach(formData: FormData) {
  "use server";
  const threadId = formData.get("threadId") as string;
  const action = formData.get("action") as string; // "send" | "cancel"
  const jobId = formData.get("jobId") as string;
  if (!threadId || !action) return;
  await fetch(`${process.env.APP_BASE_URL ?? "http://localhost:3000"}/api/outreach/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId,
      action,
      connectionNote: formData.get("connectionNote") as string,
      firstDm: formData.get("firstDm") as string,
      followup: formData.get("followup") as string,
    }),
  });
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/");
}

const THREAD_PHASE_LABEL: Record<string, string> = {
  DRAFT: "Draft — awaiting your review",
  QUEUED: "Queued — invite sends next tick",
  INVITE_PENDING: "Invite sent — awaiting acceptance",
  CONNECTED: "Connected — DM sends next tick",
  MESSAGED: "Messaged — awaiting reply",
  REPLIED: "Replied 🎉",
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
    <div className="min-h-screen bg-zinc-50">
      <div className="max-w-2xl mx-auto px-4 py-8 space-y-4">

        {/* Back */}
        <a href="/" className="inline-flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-700 transition-colors">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Board
        </a>

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
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-emerald-500 shrink-0"><circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.4"/><path d="M7 4v6M5 8.5c0 .83.67 1.5 2 1.5s2-.67 2-1.5S8.5 7 7 7s-2-.67-2-1.5S5.67 4 7 4s2 .67 2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                  <span className="text-sm font-semibold text-emerald-700">{salary}</span>
                  {job.salaryFlagReason && (
                    <span className="text-xs text-amber-600 ml-1">· ⚠ {job.salaryFlagReason.replace(/_/g, " ")}</span>
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
              <div className="flex items-center gap-2 mb-2">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-indigo-400"><path d="M7 1L8.8 5.2L13 6L9.5 9.3L10.6 13L7 11L3.4 13L4.5 9.3L1 6L5.2 5.2L7 1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
                <span className="text-xs font-semibold text-indigo-500 uppercase tracking-widest">AI Pitch</span>
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
                className="inline-flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
              >
                Open application
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 10L10 2M10 2H5M10 2v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </a>
            </div>
          )}
        </div>

        {/* Email action hint */}
        {action && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0"><path d="M7 1L8.8 5.2L13 6L9.5 9.3L10.6 13L7 11L3.4 13L4.5 9.3L1 6L5.2 5.2L7 1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
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
                className="flex-1 border border-zinc-200 rounded-lg px-3 py-2 text-sm bg-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-transparent transition"
              />
              <div className="flex gap-2 shrink-0">
                <button
                  type="submit"
                  name="action"
                  value="approve"
                  className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold transition-colors shadow-sm"
                >
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 6.5L5.5 10L11 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Approve
                </button>
                <button
                  type="submit"
                  name="action"
                  value="skip"
                  className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-600 text-sm font-medium transition-colors"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                  Skip
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Update stage — APPROVED/APPLIED */}
        {["APPROVED", "APPLIED"].includes(job.appStage) && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-6">
            <h2 className="text-sm font-semibold text-zinc-700 mb-3">Update stage</h2>
            <form action={updateStage} className="flex flex-wrap gap-2">
              <input type="hidden" name="jobId" value={job.id} />
              {["applied", "interviewing", "offer", "closed"].map(a => (
                <button
                  key={a}
                  type="submit"
                  name="action"
                  value={a}
                  className="px-3 py-1.5 rounded-lg border border-zinc-200 bg-zinc-50 hover:bg-zinc-100 text-zinc-600 text-sm font-medium capitalize transition-colors"
                >
                  {a}
                </button>
              ))}
            </form>
          </div>
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
                        className="ml-auto shrink-0 text-xs text-indigo-500 hover:text-indigo-700 font-medium flex items-center gap-1 transition-colors"
                      >
                        LinkedIn
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 8.5L8.5 1.5M8.5 1.5H4M8.5 1.5V6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
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
            <h2 className="text-sm font-semibold text-zinc-700">Job Description</h2>
          </div>
          <div className="px-6 py-4 max-h-[500px] overflow-y-auto">
            <pre className="text-sm text-zinc-600 whitespace-pre-wrap font-sans leading-relaxed">
              {job.jdText}
            </pre>
          </div>
        </div>

      </div>
    </div>
  );
}
