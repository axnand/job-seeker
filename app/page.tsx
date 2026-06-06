"use client";

import { useEffect, useState, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import {
  Sheet, SheetContent, SheetHeader,
} from "@/components/ui/sheet";
import type { AppStage, OutreachState } from "@prisma/client";

// ─── Types ────────────────────────────────────────────────────────────────────

type Job = {
  id: string; company: string; role: string; source: string;
  applyType: string; appStage: AppStage; outreachState: OutreachState;
  aiScore: number | null; aiReason: string | null; tailoredPitch: string | null;
  salaryAnnualBase: number | null; salaryCurrency: string | null;
  salaryBasis: string | null; salaryConfidence: string | null;
  salaryFlagReason: string | null; applyUrl: string; location: string | null;
  jdText: string; createdAt: string;
  outreaches?: Array<{
    id: string; role: string;
    contact: { name: string; title: string | null; linkedinUrl: string };
  }>;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const STAGES: AppStage[] = ["NEW","APPROVED","APPLIED","INTERVIEWING","OFFER","CLOSED"];
const STAGE_LABEL: Record<AppStage, string> = {
  NEW:"New", APPROVED:"Approved", SKIPPED:"Skipped",
  APPLIED:"Applied", INTERVIEWING:"Interviewing", OFFER:"Offer", CLOSED:"Closed",
};
const STAGE_ACCENT: Record<AppStage, string> = {
  NEW:"bg-slate-100", APPROVED:"bg-blue-50", SKIPPED:"bg-slate-50",
  APPLIED:"bg-violet-50", INTERVIEWING:"bg-amber-50", OFFER:"bg-emerald-50", CLOSED:"bg-red-50",
};
const SOURCE_LABEL: Record<string, string> = {
  LINKEDIN_JOB:"LinkedIn", LINKEDIN_POST:"LI Post", ADZUNA:"Adzuna",
  ATS_WATCHLIST:"Watchlist", REMOTIVE:"Remotive", REMOTEOK:"RemoteOK",
  JSEARCH:"JSearch", MANUAL:"Manual",
};
const OUTREACH_LABEL: Record<string, string> = {
  NONE:"", INVITE_SENT:"Invite sent", CONNECTED:"Connected",
  MESSAGED:"Messaged", REPLIED:"Replied ✓", NO_REPLY_ARCHIVED:"No reply",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function scoreColor(n: number | null) {
  if (n === null) return "bg-slate-100 text-slate-500";
  if (n >= 80) return "bg-green-100 text-green-800";
  if (n >= 60) return "bg-amber-100 text-amber-700";
  return "bg-red-100 text-red-700";
}

function fmtSalary(base: number | null, currency: string | null) {
  if (!base) return null;
  return new Intl.NumberFormat("en-IN", {
    style: "currency", currency: currency ?? "INR",
    maximumFractionDigits: 0, notation: "compact",
  }).format(base);
}

function companyInitial(name: string) { return name.charAt(0).toUpperCase(); }

function avatarColor(name: string) {
  const colors = [
    "bg-blue-100 text-blue-700","bg-violet-100 text-violet-700",
    "bg-emerald-100 text-emerald-700","bg-amber-100 text-amber-700",
    "bg-rose-100 text-rose-700","bg-cyan-100 text-cyan-700",
    "bg-indigo-100 text-indigo-700","bg-orange-100 text-orange-700",
  ];
  return colors[name.charCodeAt(0) % colors.length];
}

// ─── Board ────────────────────────────────────────────────────────────────────

export default function BoardPage() {
  const [jobs, setJobs]       = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Job | null>(null);
  const [detailJob, setDetailJob] = useState<Job | null>(null);
  const [copied, setCopied]   = useState(false);
  const [actioning, setActioning] = useState(false);

  useEffect(() => {
    fetch("/api/jobs?limit=200").then(r => r.json())
      .then(d => { setJobs(d.jobs ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const openDrawer = useCallback(async (job: Job) => {
    setSelected(job);
    const full = await fetch(`/api/jobs/${job.id}`).then(r => r.json()) as Job;
    setDetailJob(full);
  }, []);

  const act = useCallback(async (jobId: string, action: string) => {
    setActioning(true);
    await fetch("/api/jobs/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, action }),
    });
    const updated = await fetch(`/api/jobs/${jobId}`).then(r => r.json()) as Job;
    setDetailJob(updated);
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, appStage: updated.appStage } : j));
    setActioning(false);
  }, []);

  const byStage = STAGES.reduce<Record<string, Job[]>>((a,s) => { a[s]=[];return a; }, {});
  for (const j of jobs) if (j.appStage !== "SKIPPED" && byStage[j.appStage]) byStage[j.appStage].push(j);

  const tw = Date.now() - 7*24*60*60*1000;
  const replied    = jobs.filter(j => j.outreachState === "REPLIED").length;
  const outreached = jobs.filter(j => j.outreachState !== "NONE").length;

  const stats = [
    ["Found this week", jobs.filter(j => new Date(j.createdAt).getTime() > tw).length],
    ["Approved",        jobs.filter(j => j.appStage === "APPROVED").length],
    ["Outreach sent",   outreached],
    ["Replies",         replied],
    ["Applied",         jobs.filter(j => j.appStage === "APPLIED").length],
    ["Interviews",      jobs.filter(j => j.appStage === "INTERVIEWING").length],
    ["Response rate",   outreached ? `${Math.round(replied/outreached*100)}%` : "—"],
  ] as [string, string | number][];

  const job = detailJob ?? selected;

  return (
    <div className="px-6 py-5 space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-7 gap-3">
        {stats.map(([label, val]) => (
          <div key={label} className="bg-white border border-border rounded-lg px-4 py-3">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
            <p className="text-2xl font-bold mt-0.5">{loading ? "—" : val}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <select className="text-sm border border-border rounded-md px-3 py-1.5 bg-white text-foreground">
          <option>Source: All</option>
          {Object.entries(SOURCE_LABEL).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="text-sm border border-border rounded-md px-3 py-1.5 bg-white text-foreground">
          <option>Apply: All</option>
          <option value="REFERRAL_FIRST">Referral First</option>
          <option value="MANUAL_NOTIFY">Manual Apply</option>
        </select>
        <select className="text-sm border border-border rounded-md px-3 py-1.5 bg-white text-foreground">
          <option>Score: All</option>
          <option>Score: &gt; 80</option>
          <option>Score: &gt; 70</option>
          <option>Score: &gt; 60</option>
        </select>
      </div>

      {/* Kanban */}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {STAGES.map(stage => (
          <div key={stage} className="w-[260px] flex-shrink-0">
            <div className="flex items-center gap-2 mb-2.5 px-0.5">
              <span className="text-sm font-semibold">{STAGE_LABEL[stage]}</span>
              <span className="text-xs text-muted-foreground bg-muted rounded-full px-2 py-0.5 font-medium">
                {byStage[stage].length}
              </span>
            </div>

            <div className={`rounded-xl p-2 min-h-[120px] flex flex-col gap-2 ${STAGE_ACCENT[stage]}`}>
              {loading && <p className="text-xs text-muted-foreground m-auto">Loading…</p>}
              {!loading && byStage[stage].length === 0 && (
                <p className="text-xs text-muted-foreground m-auto">Empty</p>
              )}

              {byStage[stage].map(job => (
                <button
                  key={job.id}
                  onClick={() => openDrawer(job)}
                  className="w-full text-left bg-white rounded-lg p-3 border border-border/60 hover:border-border hover:shadow-sm transition-all"
                >
                  {/* Company + score */}
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Avatar className={`h-7 w-7 text-xs shrink-0 ${avatarColor(job.company)}`}>
                        <AvatarFallback className={`text-xs font-semibold ${avatarColor(job.company)}`}>
                          {companyInitial(job.company)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate leading-tight">{job.company}</p>
                        <p className="text-xs text-muted-foreground truncate">{job.role}</p>
                      </div>
                    </div>
                    {job.aiScore !== null && (
                      <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 ${scoreColor(job.aiScore)}`}>
                        {job.aiScore}
                      </span>
                    )}
                  </div>

                  {/* Salary */}
                  {job.salaryAnnualBase && (
                    <p className={`text-xs font-medium mb-1.5 ${job.salaryBasis === "ESTIMATED" ? "text-amber-600" : "text-emerald-700"}`}>
                      {fmtSalary(job.salaryAnnualBase, job.salaryCurrency)}/yr
                      <span className="font-normal text-muted-foreground ml-1">
                        · {job.salaryBasis === "STATED" ? "stated" : `est.`}
                        {job.salaryFlagReason && " ⚠"}
                      </span>
                    </p>
                  )}

                  {/* Badges */}
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">
                      {SOURCE_LABEL[job.source] ?? job.source}
                    </span>
                    {job.applyType === "REFERRAL_FIRST" && (
                      <span className="text-[10px] text-violet-700 border border-violet-200 bg-violet-50 rounded px-1.5 py-0.5">
                        Referral
                      </span>
                    )}
                    {job.outreachState !== "NONE" && (
                      <span className={`text-[10px] rounded px-1.5 py-0.5 ${
                        job.outreachState === "REPLIED"
                          ? "text-emerald-700 bg-emerald-50 border border-emerald-200"
                          : "text-blue-600 bg-blue-50 border border-blue-200"
                      }`}>
                        {OUTREACH_LABEL[job.outreachState]}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ── Job Detail Drawer ───────────────────────────────────────────── */}
      <Sheet open={!!selected} onOpenChange={open => { if (!open) { setSelected(null); setDetailJob(null); } }}>
        <SheetContent className="w-[520px] sm:max-w-[520px] overflow-y-auto p-0">
          <SheetHeader className="px-6 pt-5 pb-4 border-b">
            <div className="flex items-start gap-3">
              {job && (
                <Avatar className={`h-10 w-10 shrink-0 ${avatarColor(job.company)}`}>
                  <AvatarFallback className={`font-bold ${avatarColor(job.company)}`}>
                    {companyInitial(job.company)}
                  </AvatarFallback>
                </Avatar>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h2 className="font-bold text-base leading-tight">
                      {job?.company} · {job?.role}
                    </h2>
                    {job?.location && (
                      <p className="text-xs text-muted-foreground mt-0.5">{job.location}</p>
                    )}
                  </div>
                  {job?.aiScore !== null && job?.aiScore !== undefined && (
                    <div className="text-right shrink-0">
                      <p className={`text-2xl font-bold ${scoreColor(job.aiScore).split(" ")[1]}`}>{job.aiScore}</p>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">AI Score</p>
                    </div>
                  )}
                </div>

                {/* Status badges */}
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {job && (
                    <>
                      <Badge variant="outline" className="text-xs">{STAGE_LABEL[job.appStage]}</Badge>
                      <Badge variant="outline" className="text-xs">{SOURCE_LABEL[job.source] ?? job.source}</Badge>
                      {job.applyType === "REFERRAL_FIRST" && (
                        <Badge variant="outline" className="text-xs text-violet-600 border-violet-200">Referral First</Badge>
                      )}
                      {job.outreachState !== "NONE" && (
                        <Badge variant="outline" className="text-xs text-blue-600 border-blue-200">
                          {OUTREACH_LABEL[job.outreachState]}
                        </Badge>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </SheetHeader>

          {job && (
            <div className="px-6 py-5 space-y-5">
              {/* AI Analysis */}
              {job.aiReason && (
                <div>
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                    ✦ AI Analysis
                  </p>
                  <p className="text-sm text-foreground leading-relaxed">{job.aiReason}</p>
                </div>
              )}

              {/* Generated Pitch */}
              {job.tailoredPitch && (
                <div className="bg-slate-50 border border-border rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Generated Pitch (DM)</p>
                    <button
                      onClick={() => { navigator.clipboard.writeText(job.tailoredPitch!); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                    >
                      {copied ? "Copied ✓" : "Copy"}
                    </button>
                  </div>
                  <p className="text-sm text-foreground leading-relaxed italic whitespace-pre-line">
                    &ldquo;{job.tailoredPitch}&rdquo;
                  </p>
                </div>
              )}

              <Separator />

              {/* Salary + Apply */}
              <div className="flex items-center justify-between">
                <div>
                  {job.salaryAnnualBase ? (
                    <>
                      <p className={`text-xl font-bold ${job.salaryBasis === "ESTIMATED" ? "text-amber-700" : "text-foreground"}`}>
                        {fmtSalary(job.salaryAnnualBase, job.salaryCurrency)}/yr
                        <span className="text-sm font-normal text-muted-foreground ml-2">
                          {job.salaryBasis === "STATED" ? "stated" : `est. · ${job.salaryConfidence?.toLowerCase()}`}
                        </span>
                      </p>
                      {job.salaryFlagReason && (
                        <p className="text-xs text-amber-600 mt-0.5">⚠ {job.salaryFlagReason.replace(/_/g," ")}</p>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">Salary unknown</p>
                  )}
                </div>
                {job.applyUrl && (
                  <a
                    href={job.applyUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                  >
                    ↗ Apply
                  </a>
                )}
              </div>

              <Separator />

              {/* Actions */}
              {job.appStage === "NEW" && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Update Application Stage</p>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => act(job.id, "approve")}
                      disabled={actioning}
                      className="flex-1 bg-foreground hover:bg-foreground/90 text-background"
                    >
                      ✓ Approve & Queue Outreach
                    </Button>
                    <Button onClick={() => act(job.id, "skip")} disabled={actioning} variant="outline">
                      Skip
                    </Button>
                  </div>
                </div>
              )}

              {["APPROVED","APPLIED"].includes(job.appStage) && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Update Application Stage</p>
                  <div className="flex flex-wrap gap-2">
                    {["applied","interviewing","offer","closed"].map(a => (
                      <Button key={a} onClick={() => act(job.id, a)} disabled={actioning} variant="outline" size="sm" className="capitalize">
                        {a}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {/* Outreach history */}
              {(job.outreaches?.length ?? 0) > 0 && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Outreach History</p>
                    <div className="space-y-3">
                      {job.outreaches!.map(o => (
                        <div key={o.id} className="flex items-start gap-3">
                          <div className="mt-1 w-1.5 h-1.5 rounded-full bg-muted-foreground shrink-0" />
                          <div className="flex-1">
                            <div className="flex items-center justify-between">
                              <p className="text-sm font-semibold">
                                {o.contact.name}
                                {o.contact.title && (
                                  <span className="font-normal text-muted-foreground"> @ {o.contact.title}</span>
                                )}
                              </p>
                              <a href={o.contact.linkedinUrl} target="_blank" rel="noopener noreferrer"
                                className="text-xs text-blue-600 hover:underline">LinkedIn</a>
                            </div>
                            <p className="text-xs text-muted-foreground capitalize">{o.role.toLowerCase()}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* Full JD */}
              <Separator />
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Job Description</p>
                <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed max-h-80 overflow-y-auto">
                  {job.jdText}
                </pre>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
