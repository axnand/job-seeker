"use client";

/**
 * Jobs board — columns by appStage, outreachState badge on each card.
 * Client component so we can fetch via API (avoids direct DB import in RSC for now).
 */

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { AppStage } from "@prisma/client";

type Job = {
  id: string;
  company: string;
  role: string;
  source: string;
  applyType: string;
  appStage: AppStage;
  outreachState: string;
  aiScore: number | null;
  salaryAnnualBase: number | null;
  salaryCurrency: string | null;
  salaryBasis: string | null;
  createdAt: string;
};

const STAGE_ORDER: AppStage[] = ["NEW", "APPROVED", "APPLIED", "INTERVIEWING", "OFFER", "CLOSED"];

const STAGE_LABELS: Record<AppStage, string> = {
  NEW: "New",
  APPROVED: "Approved",
  SKIPPED: "Skipped",
  APPLIED: "Applied",
  INTERVIEWING: "Interviewing",
  OFFER: "Offer",
  CLOSED: "Closed",
};

const STAGE_COLORS: Record<AppStage, string> = {
  NEW: "bg-slate-100",
  APPROVED: "bg-blue-50",
  SKIPPED: "bg-slate-50",
  APPLIED: "bg-violet-50",
  INTERVIEWING: "bg-amber-50",
  OFFER: "bg-emerald-50",
  CLOSED: "bg-red-50",
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

const OUTREACH_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "outline" } > = {
  NONE:               { label: "", variant: "outline" },
  INVITE_SENT:        { label: "Invite sent", variant: "secondary" },
  CONNECTED:          { label: "Connected", variant: "secondary" },
  MESSAGED:           { label: "Messaged", variant: "default" },
  REPLIED:            { label: "Replied ✓", variant: "default" },
  NO_REPLY_ARCHIVED:  { label: "No reply", variant: "outline" },
};

function fmt(amount: number, currency: string | null) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency ?? "INR",
    maximumFractionDigits: 0,
    notation: "compact",
  }).format(amount);
}

export default function BoardPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/jobs?limit=200")
      .then(r => r.json())
      .then(d => { setJobs(d.jobs ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const byStage = STAGE_ORDER.reduce<Record<string, Job[]>>(
    (acc, s) => { acc[s] = []; return acc; }, {}
  );
  for (const j of jobs) {
    if (j.appStage !== "SKIPPED" && byStage[j.appStage]) byStage[j.appStage].push(j);
  }

  const thisWeek = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekCount = jobs.filter(j => new Date(j.createdAt).getTime() > thisWeek).length;
  const replied    = jobs.filter(j => j.outreachState === "REPLIED").length;
  const outreached = jobs.filter(j => j.outreachState !== "NONE").length;
  const rr         = outreached > 0 ? Math.round((replied / outreached) * 100) : 0;

  const stats = [
    { label: "Found this week", value: weekCount },
    { label: "Approved",        value: jobs.filter(j => j.appStage === "APPROVED").length },
    { label: "Outreach sent",   value: outreached },
    { label: "Replies",         value: replied },
    { label: "Applied",         value: jobs.filter(j => j.appStage === "APPLIED").length },
    { label: "Interviews",      value: jobs.filter(j => j.appStage === "INTERVIEWING").length },
    { label: "Response rate",   value: `${rr}%` },
  ];

  return (
    <div className="space-y-6">
      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {stats.map(s => (
          <Card key={s.label} className="py-3">
            <CardContent className="px-4 py-0">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="text-xl font-bold mt-0.5">{loading ? "—" : s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Separator />

      {/* Kanban */}
      <ScrollArea className="w-full">
        <div className="flex gap-4 pb-4 min-w-max">
          {STAGE_ORDER.map(stage => (
            <div key={stage} className="w-64 flex-shrink-0 flex flex-col gap-2">
              {/* Column header */}
              <div className="flex items-center justify-between px-1">
                <span className="text-sm font-semibold text-foreground">{STAGE_LABELS[stage]}</span>
                <Badge variant="secondary" className="text-xs rounded-full px-2">
                  {byStage[stage].length}
                </Badge>
              </div>

              {/* Cards */}
              <div className={`rounded-xl p-2 min-h-32 flex flex-col gap-2 ${STAGE_COLORS[stage]}`}>
                {loading && (
                  <div className="flex-1 flex items-center justify-center">
                    <span className="text-xs text-muted-foreground">Loading…</span>
                  </div>
                )}
                {!loading && byStage[stage].length === 0 && (
                  <div className="flex-1 flex items-center justify-center">
                    <span className="text-xs text-muted-foreground">Empty</span>
                  </div>
                )}
                {byStage[stage].map(job => (
                  <a key={job.id} href={`/jobs/${job.id}`}>
                    <Card className="hover:shadow-md transition-shadow cursor-pointer border-border/60">
                      <CardHeader className="px-3 pt-3 pb-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-semibold text-sm truncate leading-tight">{job.company}</p>
                            <p className="text-xs text-muted-foreground truncate mt-0.5">{job.role}</p>
                          </div>
                          {job.aiScore !== null && (
                            <Badge variant="secondary" className="text-xs shrink-0 font-bold">
                              {job.aiScore}
                            </Badge>
                          )}
                        </div>
                      </CardHeader>
                      <CardContent className="px-3 pb-3 pt-1 space-y-1.5">
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            {SOURCE_LABELS[job.source] ?? job.source}
                          </Badge>
                          {job.applyType === "REFERRAL_FIRST" && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-violet-600 border-violet-200">
                              Referral
                            </Badge>
                          )}
                        </div>
                        {job.salaryAnnualBase && (
                          <p className="text-xs text-emerald-700 font-medium">
                            {fmt(job.salaryAnnualBase, job.salaryCurrency)}
                            {job.salaryBasis === "ESTIMATED" && <span className="text-muted-foreground font-normal"> est.</span>}
                          </p>
                        )}
                        {job.outreachState !== "NONE" && OUTREACH_BADGE[job.outreachState] && (
                          <Badge
                            variant={OUTREACH_BADGE[job.outreachState].variant}
                            className="text-[10px] px-1.5 py-0"
                          >
                            {OUTREACH_BADGE[job.outreachState].label}
                          </Badge>
                        )}
                      </CardContent>
                    </Card>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
