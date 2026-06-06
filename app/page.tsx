/**
 * Jobs board — columns by appStage, outreachState badge on each card.
 * Server component: fetches directly from DB.
 */

import { prisma } from "@/lib/prisma";
import type { AppStage } from "@prisma/client";

const STAGE_ORDER: AppStage[] = [
  "NEW", "APPROVED", "APPLIED", "INTERVIEWING", "OFFER", "CLOSED",
];

const STAGE_LABELS: Record<AppStage, string> = {
  NEW: "New",
  APPROVED: "Approved",
  SKIPPED: "Skipped",
  APPLIED: "Applied",
  INTERVIEWING: "Interviewing",
  OFFER: "Offer",
  CLOSED: "Closed",
};

const OUTREACH_BADGE: Record<string, string> = {
  NONE: "",
  INVITE_SENT: "📨 Invite sent",
  CONNECTED: "🔗 Connected",
  MESSAGED: "💬 Messaged",
  REPLIED: "✉️ Replied",
  NO_REPLY_ARCHIVED: "🗃 Archived",
};

const SOURCE_LABELS: Record<string, string> = {
  LINKEDIN_JOB: "LinkedIn",
  LINKEDIN_POST: "LI Post",
  ADZUNA: "Adzuna",
  ATS_WATCHLIST: "Watchlist",
  REMOTIVE: "Remotive",
  REMOTEOK: "RemoteOK",
  JSEARCH: "JSearch",
  MANUAL: "Manual",
};

function formatSalary(annualBase: number | null, currency: string | null): string {
  if (!annualBase) return "";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency ?? "INR",
    maximumFractionDigits: 0,
    notation: "compact",
  }).format(annualBase);
}

export default async function BoardPage() {
  const jobs = await prisma.job.findMany({
    where: { appStage: { not: "SKIPPED" } },
    orderBy: [{ aiScore: "desc" }, { createdAt: "desc" }],
    take: 500,
  });

  const byStage = STAGE_ORDER.reduce<Record<AppStage, typeof jobs>>(
    (acc, s) => { acc[s] = []; return acc; },
    {} as Record<AppStage, typeof jobs>
  );
  for (const job of jobs) {
    if (byStage[job.appStage]) byStage[job.appStage].push(job);
  }

  // Stats
  const thisWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const weekJobs = jobs.filter(j => j.createdAt >= thisWeek);
  const replied = jobs.filter(j => j.outreachState === "REPLIED").length;
  const outreachSent = jobs.filter(j => !["NONE"].includes(j.outreachState)).length;
  const responseRate = outreachSent > 0 ? Math.round((replied / outreachSent) * 100) : 0;

  return (
    <div>
      {/* Stats bar */}
      <div className="flex flex-wrap gap-4 mb-6 text-sm">
        {[
          ["Found this week", weekJobs.length],
          ["Approved", jobs.filter(j => j.appStage === "APPROVED").length],
          ["Outreach sent", outreachSent],
          ["Replies", replied],
          ["Applied", jobs.filter(j => j.appStage === "APPLIED").length],
          ["Interviews", jobs.filter(j => j.appStage === "INTERVIEWING").length],
          ["Response rate", `${responseRate}%`],
        ].map(([label, val]) => (
          <div key={String(label)} className="bg-white border border-gray-200 rounded-lg px-4 py-2">
            <p className="text-gray-500 text-xs">{label}</p>
            <p className="font-semibold text-gray-900">{val}</p>
          </div>
        ))}
      </div>

      {/* Kanban */}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {STAGE_ORDER.filter(s => s !== "SKIPPED").map(stage => (
          <div key={stage} className="flex-shrink-0 w-64">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-medium text-gray-700 text-sm">{STAGE_LABELS[stage]}</h3>
              <span className="text-xs text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">
                {byStage[stage].length}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {byStage[stage].map(job => (
                <a
                  key={job.id}
                  href={`/jobs/${job.id}`}
                  className="block bg-white border border-gray-200 rounded-lg p-3 hover:border-blue-300 hover:shadow-sm transition-all"
                >
                  <p className="font-medium text-gray-900 text-sm truncate">{job.company}</p>
                  <p className="text-gray-600 text-xs truncate mb-1">{job.role}</p>
                  <div className="flex items-center justify-between">
                    <span className="text-xs bg-blue-50 text-blue-700 rounded px-1.5 py-0.5 font-medium">
                      {job.aiScore ?? "—"}/100
                    </span>
                    <span className="text-xs text-gray-400">{SOURCE_LABELS[job.source] ?? job.source}</span>
                  </div>
                  {job.salaryAnnualBase && (
                    <p className="text-xs text-emerald-600 mt-1">
                      {formatSalary(job.salaryAnnualBase, job.salaryCurrency)}
                      {job.salaryBasis === "ESTIMATED" && " (est.)"}
                    </p>
                  )}
                  {job.outreachState !== "NONE" && (
                    <p className="text-xs text-gray-400 mt-1">{OUTREACH_BADGE[job.outreachState]}</p>
                  )}
                  {job.applyType === "REFERRAL_FIRST" && (
                    <span className="inline-block mt-1 text-xs bg-purple-50 text-purple-700 rounded px-1.5 py-0.5">Referral First</span>
                  )}
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
