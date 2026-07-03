import { PageHeader } from "@/components/page-header";
import { BarChart3, Inbox } from "lucide-react";
import { computeAnalytics, ALL_STAGES } from "@/analytics/aggregate";
import type { AppStage } from "@prisma/client";

// Server-rendered — read fresh on every request (funnel changes as outreach runs).
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

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
const ratio = (num: number, den: number) => (den > 0 ? `${Math.round((num / den) * 100)}%` : "—");

const PURPOSE_LABEL: Record<string, string> = {
  scoring: "Job scoring",
  tailoring: "Resume tailoring",
  tailor_repair: "Tailoring repairs",
  post_extraction: "Post extraction",
  other: "Other",
};

const usd = (v: number | null) => (v === null ? "—" : `$${v.toFixed(2)}`);
const tok = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${(v / 1_000).toFixed(1)}K` : String(v));

export default async function AnalyticsPage() {
  const { totals, pipeline, bySource, llmSpend } = await computeAnalytics();

  const tiles: { label: string; value: string; color: string }[] = [
    { label: "Total jobs",       value: totals.jobs.toLocaleString(),   color: "text-foreground" },
    { label: "Approval rate",    value: pct(totals.approvalRate),        color: "text-blue-600 dark:text-blue-300" },
    { label: "Invite → accept",  value: pct(totals.inviteAcceptRate),    color: "text-indigo-600 dark:text-indigo-300" },
    { label: "Accept → reply",   value: pct(totals.acceptReplyRate),     color: "text-emerald-600 dark:text-emerald-300" },
    { label: "In pipeline",      value: totals.inPipeline.toLocaleString(), color: "text-violet-600 dark:text-violet-300" },
  ];

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden bg-background">
      <PageHeader
        title="Analytics"
        subtitle="Which sources and messages actually convert"
        icon={<BarChart3 className="size-4" />}
      />

      <div className="flex-1 overflow-y-auto scrollbar-slim px-6 py-6 space-y-6">

        {/* ── Stat tiles ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {tiles.map(({ label, value, color }) => (
            <div key={label} className="bg-card rounded-xl border border-border shadow-sm px-4 py-3">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1">{label}</p>
              <p className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
            </div>
          ))}
        </div>

        {/* ── Overall funnel ─────────────────────────────────────────── */}
        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Conversion funnel</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Discovered jobs down to a reply — the whole pipeline at a glance.</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-6 divide-y md:divide-y-0 md:divide-x divide-border">
            {[
              { label: "Discovered",    value: totals.jobs,          sub: null },
              { label: "Passed scoring", value: totals.passedScoring, sub: ratio(totals.passedScoring, totals.jobs) },
              { label: "Approved+",     value: totals.approvedPlus,  sub: ratio(totals.approvedPlus, totals.passedScoring) },
              { label: "Invites sent",  value: totals.invitesSent,   sub: null },
              { label: "Accepted",      value: totals.accepted,      sub: ratio(totals.accepted, totals.invitesSent) },
              { label: "Replied",       value: totals.replied,       sub: ratio(totals.replied, totals.accepted) },
            ].map(({ label, value, sub }) => (
              <div key={label} className="px-5 py-4">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">{label}</p>
                <p className="text-xl font-semibold tabular-nums text-foreground mt-1">{value.toLocaleString()}</p>
                {sub && <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5">{sub} of prior</p>}
              </div>
            ))}
          </div>
        </div>

        {/* ── Per-source funnel table ─────────────────────────────────── */}
        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">By source</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Where your best conversions come from.</p>
          </div>

          {bySource.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
              <Inbox className="size-6" />
              <p className="text-sm font-medium">No jobs discovered yet.</p>
              <p className="text-xs">Conversion data appears once jobs start flowing in.</p>
            </div>
          ) : (
            <div className="overflow-x-auto scrollbar-slim">
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest border-b border-border">
                    <th className="text-left font-semibold px-5 py-2.5">Source</th>
                    <th className="text-right font-semibold px-3 py-2.5">Jobs</th>
                    <th className="text-right font-semibold px-3 py-2.5">Passed</th>
                    <th className="text-right font-semibold px-3 py-2.5">Approved+</th>
                    <th className="text-right font-semibold px-3 py-2.5">Invites</th>
                    <th className="text-right font-semibold px-3 py-2.5">Accepted</th>
                    <th className="text-right font-semibold px-3 py-2.5">Replied</th>
                    <th className="text-right font-semibold px-5 py-2.5">Reply rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {bySource.map((r) => (
                    <tr key={r.source} className="hover:bg-muted/50 transition-colors">
                      <td className="px-5 py-2.5 text-left font-medium text-foreground tracking-normal">
                        {SOURCE_LABEL[r.source] ?? r.source}
                      </td>
                      <td className="px-3 py-2.5 text-right text-foreground">{r.jobs.toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right text-muted-foreground">{r.passedScoring.toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right text-blue-600 dark:text-blue-300 font-medium">{r.approvedPlus.toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right text-muted-foreground">{r.invitesSent.toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right text-indigo-600 dark:text-indigo-300 font-medium">{r.accepted.toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right text-emerald-600 dark:text-emerald-300 font-semibold">{r.replied.toLocaleString()}</td>
                      <td className="px-5 py-2.5 text-right text-muted-foreground">{ratio(r.replied, r.invitesSent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── LLM spend (30 days) ─────────────────────────────────────── */}
        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">LLM spend — last 30 days</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Token usage per purpose; cost is an estimate from public pricing.</p>
          </div>
          {llmSpend.length === 0 ? (
            <p className="px-5 py-6 text-xs text-muted-foreground">No usage recorded yet — the ledger fills as LLM calls run.</p>
          ) : (
            <div className="overflow-x-auto scrollbar-slim">
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest border-b border-border">
                    <th className="text-left font-semibold px-5 py-2.5">Purpose</th>
                    <th className="text-right font-semibold px-3 py-2.5">Calls</th>
                    <th className="text-right font-semibold px-3 py-2.5">Input tokens</th>
                    <th className="text-right font-semibold px-3 py-2.5">Output tokens</th>
                    <th className="text-right font-semibold px-5 py-2.5">Est. cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {llmSpend.map((r) => (
                    <tr key={r.purpose} className="hover:bg-muted/50 transition-colors">
                      <td className="px-5 py-2.5 text-left font-medium text-foreground">{PURPOSE_LABEL[r.purpose] ?? r.purpose}</td>
                      <td className="px-3 py-2.5 text-right text-foreground">{r.calls.toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right text-muted-foreground">{tok(r.promptTokens)}</td>
                      <td className="px-3 py-2.5 text-right text-muted-foreground">{tok(r.completionTokens)}</td>
                      <td className="px-5 py-2.5 text-right text-indigo-600 dark:text-indigo-300 font-medium">{usd(r.estCostUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Pipeline by stage ───────────────────────────────────────── */}
        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Pipeline by stage</h2>
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-3 px-5 py-4">
            {ALL_STAGES.map((stage) => (
              <div key={stage} className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full shrink-0 ${STAGE_DOT[stage]}`} />
                <span className="text-xs text-muted-foreground">{STAGE_LABEL[stage]}</span>
                <span className="text-sm font-semibold tabular-nums text-foreground">{pipeline[stage].toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
