import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Archive, Inbox, ExternalLink } from "lucide-react";
import { parseHistoryParams, fetchHistory, type HistoryJob } from "@/history/query";
import { HistoryFilters } from "@/components/history-filters";
import type { AppStage } from "@prisma/client";

// Server-rendered, read fresh on every request — same convention as /analytics.
export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = {
  LINKEDIN_JOB: "LinkedIn", LINKEDIN_POST: "LI Post", ADZUNA: "Adzuna",
  ATS_WATCHLIST: "Watchlist", REMOTIVE: "Remotive", REMOTEOK: "RemoteOK",
  JSEARCH: "JSearch", MANUAL: "Manual",
};

const STAGE_LABEL: Record<AppStage, string> = {
  NEW: "New", APPROVED: "Approved", OUTREACH: "Outreach", REPLIED: "Replied",
  APPLIED: "Applied", INTERVIEWING: "Interviewing", OFFER: "Offer", SKIPPED: "Skipped",
};

const STAGE_DOT: Record<AppStage, string> = {
  NEW: "bg-zinc-400", APPROVED: "bg-blue-500", OUTREACH: "bg-indigo-500", REPLIED: "bg-emerald-500",
  APPLIED: "bg-violet-500", INTERVIEWING: "bg-amber-500", OFFER: "bg-green-500", SKIPPED: "bg-zinc-300",
};

const SKIP_LABEL: Record<string, string> = {
  MANUAL: "Manual", AI_TRIAGE: "AI triage", AI_SCORE: "AI score", STALE: "Stale", BLACKLIST: "Blacklist",
};

const fmtSalary = (base: number | null, cur: string | null) =>
  !base ? "—" : new Intl.NumberFormat("en-IN", {
    style: "currency", currency: cur ?? "INR", maximumFractionDigits: 0, notation: "compact",
  }).format(base);

const fmtDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

function toStr(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const sp: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) sp[k] = toStr(v);

  const params = parseHistoryParams(sp);
  const { jobs, total, page, pageSize } = await fetchHistory(params);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  const pageHref = (p: number) => {
    const next = new URLSearchParams(
      Object.entries(sp).filter((e): e is [string, string] => e[1] !== undefined)
    );
    next.set("page", String(p));
    return `/history?${next.toString()}`;
  };

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden bg-background">
      <PageHeader
        title="History"
        subtitle="Every job the system has ever discovered — including skipped and auto-rejected"
        icon={<Archive className="size-4" />}
      />

      <div className="flex-1 overflow-y-auto scrollbar-slim px-6 py-6 space-y-4">
        <HistoryFilters />

        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
          {jobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
              <Inbox className="size-6" />
              <p className="text-sm font-medium">No jobs match these filters.</p>
              <p className="text-xs">Try widening the stage, salary, or date range.</p>
            </div>
          ) : (
            <div className="overflow-x-auto scrollbar-slim">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest border-b border-border">
                    <th className="text-left font-semibold px-5 py-2.5">Company</th>
                    <th className="text-left font-semibold px-3 py-2.5">Role</th>
                    <th className="text-left font-semibold px-3 py-2.5">Source</th>
                    <th className="text-left font-semibold px-3 py-2.5">Stage</th>
                    <th className="text-right font-semibold px-3 py-2.5">Score</th>
                    <th className="text-right font-semibold px-3 py-2.5">Salary</th>
                    <th className="text-right font-semibold px-5 py-2.5">Discovered</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {jobs.map((job: HistoryJob) => (
                    <tr key={job.id} className="hover:bg-muted/50 transition-colors">
                      <td className="px-5 py-2.5 text-left font-medium text-foreground">
                        {job.pinned && <span className="mr-1 text-amber-500">★</span>}
                        {job.company}
                      </td>
                      <td className="px-3 py-2.5 text-left text-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          <Link href={`/jobs/${job.id}`} className="hover:underline underline-offset-2">
                            {job.role}
                          </Link>
                          {job.applyUrl && (
                            <a
                              href={job.applyUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Open application"
                              className="text-muted-foreground hover:text-primary transition-colors"
                            >
                              <ExternalLink className="size-3" />
                            </a>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-left text-muted-foreground">
                        {SOURCE_LABEL[job.source] ?? job.source}
                      </td>
                      <td className="px-3 py-2.5 text-left">
                        <span className="inline-flex items-center gap-1.5">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${STAGE_DOT[job.appStage]}`} />
                          <span className="text-foreground">{STAGE_LABEL[job.appStage]}</span>
                          {job.appStage === "SKIPPED" && job.skipSource && (
                            <span className="text-[11px] text-muted-foreground">
                              · {SKIP_LABEL[job.skipSource] ?? job.skipSource}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                        {job.aiScore ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                        {fmtSalary(job.salaryAnnualBase, job.salaryCurrency)}
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-muted-foreground">
                        {fmtDate(job.discoveredAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{total === 0 ? "No results" : `Showing ${from}–${to} of ${total.toLocaleString()}`}</span>
          <div className="flex items-center gap-2">
            {page > 1 ? (
              <Link href={pageHref(page - 1)} className="px-2.5 py-1.5 rounded-lg border border-border hover:bg-muted transition-colors">
                Prev
              </Link>
            ) : (
              <span className="px-2.5 py-1.5 rounded-lg border border-border opacity-40">Prev</span>
            )}
            <span className="tabular-nums">Page {page} of {totalPages}</span>
            {page < totalPages ? (
              <Link href={pageHref(page + 1)} className="px-2.5 py-1.5 rounded-lg border border-border hover:bg-muted transition-colors">
                Next
              </Link>
            ) : (
              <span className="px-2.5 py-1.5 rounded-lg border border-border opacity-40">Next</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
