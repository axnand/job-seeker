"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Sheet, SheetContent, SheetHeader } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
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

// ─── Config ───────────────────────────────────────────────────────────────────

const STAGES: AppStage[] = ["NEW","APPROVED","APPLIED","INTERVIEWING","OFFER","CLOSED"];

const STAGE_META: Record<AppStage, { label: string; dot: string; lane: string }> = {
  NEW:          { label: "New",          dot: "bg-zinc-400",    lane: "bg-zinc-50 border-zinc-200"     },
  APPROVED:     { label: "Approved",     dot: "bg-blue-500",    lane: "bg-blue-50 border-blue-100"     },
  SKIPPED:      { label: "Skipped",      dot: "bg-zinc-300",    lane: "bg-zinc-50 border-zinc-200"     },
  APPLIED:      { label: "Applied",      dot: "bg-violet-500",  lane: "bg-violet-50 border-violet-100" },
  INTERVIEWING: { label: "Interviewing", dot: "bg-amber-500",   lane: "bg-amber-50 border-amber-100"   },
  OFFER:        { label: "Offer",        dot: "bg-emerald-500", lane: "bg-emerald-50 border-emerald-100"},
  CLOSED:       { label: "Closed",       dot: "bg-red-400",     lane: "bg-red-50 border-red-100"       },
};

const SOURCE_LABEL: Record<string, string> = {
  LINKEDIN_JOB:"LinkedIn", LINKEDIN_POST:"LI Post", ADZUNA:"Adzuna",
  ATS_WATCHLIST:"Watchlist", REMOTIVE:"Remotive", REMOTEOK:"RemoteOK",
  JSEARCH:"JSearch", MANUAL:"Manual",
};

const OUTREACH_META: Record<string, { text: string; cls: string }> = {
  NONE:              { text: "",           cls: "" },
  INVITE_SENT:       { text: "Invite sent",cls: "text-blue-600 bg-blue-50 border-blue-200" },
  CONNECTED:         { text: "Connected",  cls: "text-blue-600 bg-blue-50 border-blue-200" },
  MESSAGED:          { text: "Messaged",   cls: "text-indigo-600 bg-indigo-50 border-indigo-200" },
  REPLIED:           { text: "Replied ✓",  cls: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  NO_REPLY_ARCHIVED: { text: "No reply",   cls: "text-zinc-500 bg-zinc-100 border-zinc-200" },
};

// ─── Utils ────────────────────────────────────────────────────────────────────

const scoreClr = (n: number | null) =>
  n === null ? "bg-zinc-100 text-zinc-400" :
  n >= 80 ? "bg-green-100 text-green-800" :
  n >= 60 ? "bg-amber-100 text-amber-800" :
  "bg-red-100 text-red-700";

const AVATAR_COLORS = [
  "bg-blue-100 text-blue-700","bg-violet-100 text-violet-700",
  "bg-emerald-100 text-emerald-700","bg-amber-100 text-amber-800",
  "bg-rose-100 text-rose-700","bg-cyan-100 text-cyan-700",
  "bg-indigo-100 text-indigo-700","bg-orange-100 text-orange-800",
];
const avatarClr = (name: string) => AVATAR_COLORS[name.charCodeAt(0) % 8];

const fmtSalary = (base: number | null, cur: string | null) =>
  !base ? null : new Intl.NumberFormat("en-IN", {
    style: "currency", currency: cur ?? "INR",
    maximumFractionDigits: 0, notation: "compact",
  }).format(base);

// ─── Board ────────────────────────────────────────────────────────────────────

export default function BoardPage() {
  const [jobs, setJobs]         = useState<Job[]>([]);
  const [loading, setLoading]   = useState(true);
  const [selected, setSelected] = useState<Job | null>(null);
  const [detail, setDetail]     = useState<Job | null>(null);
  const [copied, setCopied]     = useState(false);
  const [acting, setActing]     = useState(false);
  const scrollRef               = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/jobs?limit=200")
      .then(r => r.json())
      .then(d => { setJobs(d.jobs ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const openJob = useCallback(async (job: Job) => {
    setSelected(job); setDetail(null);
    const full = await fetch(`/api/jobs/${job.id}`).then(r => r.json()) as Job;
    setDetail(full);
  }, []);

  const act = useCallback(async (jobId: string, action: string) => {
    setActing(true);
    await fetch("/api/jobs/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, action }),
    });
    const updated = await fetch(`/api/jobs/${jobId}`).then(r => r.json()) as Job;
    setDetail(updated);
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, appStage: updated.appStage } : j));
    setActing(false);
  }, []);

  const byStage = STAGES.reduce<Record<string, Job[]>>((a, s) => { a[s] = []; return a; }, {});
  for (const j of jobs) {
    if (j.appStage !== "SKIPPED" && byStage[j.appStage]) byStage[j.appStage].push(j);
  }

  const tw       = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const replied  = jobs.filter(j => j.outreachState === "REPLIED").length;
  const sent     = jobs.filter(j => j.outreachState !== "NONE").length;
  const rr       = sent > 0 ? `${Math.round(replied / sent * 100)}%` : "—";

  const stats = [
    { label: "Found this week", value: loading ? "—" : jobs.filter(j => new Date(j.createdAt).getTime() > tw).length },
    { label: "Approved",        value: loading ? "—" : jobs.filter(j => j.appStage === "APPROVED").length },
    { label: "Outreach sent",   value: loading ? "—" : sent },
    { label: "Replies",         value: loading ? "—" : replied },
    { label: "Applied",         value: loading ? "—" : jobs.filter(j => j.appStage === "APPLIED").length },
    { label: "Interviews",      value: loading ? "—" : jobs.filter(j => j.appStage === "INTERVIEWING").length },
    { label: "Response rate",   value: loading ? "—" : rr },
  ];

  const job = detail ?? selected;

  return (
    <div className="flex flex-col h-[calc(100vh-44px)] overflow-hidden">

      {/* ── Top bar: stats + filters ───────────────────────────────── */}
      <div className="flex-shrink-0 border-b border-zinc-200 bg-white px-8 py-5 space-y-4">

        {/* Stats row */}
        <div className="flex items-center gap-8">
          {stats.map(({ label, value }) => (
            <div key={label} className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-zinc-900 tabular-nums">{value}</span>
              <span className="text-xs text-zinc-400 whitespace-nowrap">{label}</span>
            </div>
          ))}
          <a href="/add"
            className="ml-auto shrink-0 bg-zinc-900 hover:bg-zinc-700 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">
            + Add Job
          </a>
        </div>

        {/* Filter row */}
        <div className="flex items-center gap-2">
          {(["Source: All", "Apply type: All", "Score: All"] as const).map(label => (
            <select key={label} className="text-xs border border-zinc-200 rounded-lg px-2.5 py-1.5 bg-white text-zinc-600 focus:outline-none focus:border-zinc-400">
              <option>{label}</option>
            </select>
          ))}
          <div className="ml-auto flex items-center gap-0.5 text-xs text-zinc-400">
            <span className="mr-1">Sort:</span>
            {["Score", "Salary", "Date"].map(s => (
              <button key={s} className="px-2 py-1 rounded hover:bg-zinc-100 hover:text-zinc-700 transition-colors">{s}</button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Kanban ────────────────────────────────────────────────────── */}
      <div ref={scrollRef} className="flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full gap-0 min-w-max">
          {STAGES.map(stage => {
            const meta = STAGE_META[stage];
            const cards = byStage[stage];
            return (
              <div key={stage} className="w-[272px] flex-shrink-0 flex flex-col border-r border-zinc-200 last:border-r-0">

                {/* Column header */}
                <div className="flex-shrink-0 flex items-center gap-2 px-5 py-4 border-b border-zinc-200 bg-white">
                  <div className={`w-2 h-2 rounded-full shrink-0 ${meta.dot}`} />
                  <span className="text-sm font-semibold text-zinc-800">{meta.label}</span>
                  <span className="ml-auto text-xs font-medium text-zinc-400 tabular-nums bg-zinc-100 rounded-full px-2 py-0.5">
                    {cards.length}
                  </span>
                </div>

                {/* Cards lane */}
                <div className={`flex-1 overflow-y-auto p-4 space-y-3 ${meta.lane} border-0`}>
                  {loading ? (
                    <div className="flex flex-col gap-2">
                      {[1,2].map(i => (
                        <div key={i} className="bg-white/60 rounded-lg h-20 animate-pulse border border-zinc-200/60" />
                      ))}
                    </div>
                  ) : cards.length === 0 ? (
                    <div className="h-16 flex items-center justify-center">
                      <p className="text-xs text-zinc-400/70">No jobs</p>
                    </div>
                  ) : (
                    cards.map(job => {
                      const sal = fmtSalary(job.salaryAnnualBase, job.salaryCurrency);
                      const outreach = OUTREACH_META[job.outreachState];
                      return (
                        <button
                          key={job.id}
                          onClick={() => openJob(job)}
                          className="w-full text-left bg-white rounded-xl p-4 border border-zinc-200/80 hover:border-zinc-300 hover:shadow-sm active:scale-[0.98] transition-all block"
                        >
                          {/* Header */}
                          <div className="flex items-start gap-2 mb-2">
                            <Avatar className={`h-7 w-7 rounded-lg shrink-0 ${avatarClr(job.company)}`}>
                              <AvatarFallback className={`rounded-lg text-xs font-bold ${avatarClr(job.company)}`}>
                                {job.company.charAt(0).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-semibold text-zinc-900 truncate">{job.company}</p>
                              <p className="text-xs text-zinc-500 truncate leading-tight mt-0.5">{job.role}</p>
                            </div>
                            {job.aiScore !== null && (
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md shrink-0 ${scoreClr(job.aiScore)}`}>
                                {job.aiScore}
                              </span>
                            )}
                          </div>

                          {/* Salary */}
                          {sal && (
                            <p className={`text-[10px] font-medium mb-1.5 ${job.salaryBasis === "ESTIMATED" ? "text-amber-600" : "text-emerald-600"}`}>
                              {sal}/yr · <span className="text-zinc-400 font-normal">{job.salaryBasis === "STATED" ? "stated" : "est."}</span>
                            </p>
                          )}

                          {/* Chips */}
                          <div className="flex flex-wrap gap-1">
                            <span className="text-[9px] text-zinc-500 border border-zinc-200 rounded px-1.5 py-0.5">
                              {SOURCE_LABEL[job.source] ?? job.source}
                            </span>
                            {job.applyType === "REFERRAL_FIRST" && (
                              <span className="text-[9px] text-violet-600 border border-violet-200 bg-violet-50/60 rounded px-1.5 py-0.5">
                                Referral
                              </span>
                            )}
                            {outreach.text && (
                              <span className={`text-[9px] border rounded px-1.5 py-0.5 ${outreach.cls}`}>
                                {outreach.text}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Job Drawer ────────────────────────────────────────────────── */}
      <Sheet open={!!selected} onOpenChange={v => { if (!v) { setSelected(null); setDetail(null); } }}>
        <SheetContent className="!w-[480px] !max-w-[480px] p-0 flex flex-col" showCloseButton>
          {/* Header */}
          <SheetHeader className="px-6 pt-6 pb-5 border-b border-zinc-200 flex-shrink-0">
            <div className="flex items-start gap-3 pr-6">
              {job && (
                <Avatar className={`h-9 w-9 rounded-xl shrink-0 ${avatarClr(job.company)}`}>
                  <AvatarFallback className={`rounded-xl font-bold text-sm ${avatarClr(job.company)}`}>
                    {job.company.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-bold text-sm leading-tight">{job?.company}</p>
                    <p className="text-xs text-zinc-500 mt-0.5 leading-tight">{job?.role}</p>
                    {job?.location && <p className="text-[10px] text-zinc-400 mt-0.5">{job.location}</p>}
                  </div>
                  {job?.aiScore !== null && job?.aiScore !== undefined && (
                    <div className={`shrink-0 text-center px-2.5 py-1 rounded-lg ${scoreClr(job.aiScore)}`}>
                      <p className="text-lg font-bold leading-none">{job.aiScore}</p>
                      <p className="text-[8px] font-semibold uppercase tracking-widest mt-0.5 opacity-60">score</p>
                    </div>
                  )}
                </div>

                {job && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    <span className="text-[10px] border border-zinc-200 rounded px-1.5 py-0.5 text-zinc-500">
                      {STAGE_META[job.appStage].label}
                    </span>
                    <span className="text-[10px] border border-zinc-200 rounded px-1.5 py-0.5 text-zinc-400">
                      {SOURCE_LABEL[job.source] ?? job.source}
                    </span>
                    {job.applyType === "REFERRAL_FIRST" && (
                      <span className="text-[10px] border border-violet-200 bg-violet-50 text-violet-700 rounded px-1.5 py-0.5">Referral First</span>
                    )}
                    {job.outreachState !== "NONE" && OUTREACH_META[job.outreachState].text && (
                      <span className={`text-[10px] border rounded px-1.5 py-0.5 ${OUTREACH_META[job.outreachState].cls}`}>
                        {OUTREACH_META[job.outreachState].text}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </SheetHeader>

          {/* Body */}
          {job && (
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

              {/* AI reason */}
              {job.aiReason && (
                <div>
                  <p className="text-[9px] font-semibold text-zinc-400 uppercase tracking-widest mb-1.5">✦ AI Analysis</p>
                  <p className="text-sm text-zinc-700 leading-relaxed">{job.aiReason}</p>
                </div>
              )}

              {/* Pitch */}
              {job.tailoredPitch && (
                <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[9px] font-semibold text-zinc-400 uppercase tracking-widest">Generated Pitch</p>
                    <button
                      onClick={() => { navigator.clipboard.writeText(job.tailoredPitch!); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                      className="text-xs text-zinc-400 hover:text-zinc-700 transition-colors"
                    >
                      {copied ? "Copied ✓" : "Copy"}
                    </button>
                  </div>
                  <p className="text-sm text-zinc-700 leading-relaxed italic whitespace-pre-line">&ldquo;{job.tailoredPitch}&rdquo;</p>
                </div>
              )}

              <Separator />

              {/* Salary + Apply */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  {job.salaryAnnualBase ? (
                    <>
                      <p className={`text-lg font-bold ${job.salaryBasis === "ESTIMATED" ? "text-amber-700" : "text-zinc-900"}`}>
                        {fmtSalary(job.salaryAnnualBase, job.salaryCurrency)}/yr
                      </p>
                      <p className="text-xs text-zinc-400 mt-0.5">
                        {job.salaryBasis === "STATED" ? "Stated salary" : `Estimated · ${job.salaryConfidence?.toLowerCase() ?? "low"} confidence`}
                      </p>
                      {job.salaryFlagReason && <p className="text-xs text-amber-600 mt-0.5">⚠ {job.salaryFlagReason.replace(/_/g," ")}</p>}
                    </>
                  ) : <p className="text-sm text-zinc-400">Salary unknown</p>}
                </div>
                {job.applyUrl && (
                  <a href={job.applyUrl} target="_blank" rel="noopener noreferrer"
                    className="shrink-0 inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors">
                    ↗ Apply
                  </a>
                )}
              </div>

              <Separator />

              {/* Stage actions */}
              {job.appStage === "NEW" && (
                <div className="space-y-2">
                  <p className="text-[9px] font-semibold text-zinc-400 uppercase tracking-widest">Actions</p>
                  <div className="flex gap-2">
                    <Button onClick={() => act(job.id, "approve")} disabled={acting} size="sm"
                      className="flex-1 bg-zinc-900 hover:bg-zinc-800 text-white text-xs">
                      ✓ Approve &amp; Queue Outreach
                    </Button>
                    <Button onClick={() => act(job.id, "skip")} disabled={acting} variant="outline" size="sm" className="text-xs">
                      Skip
                    </Button>
                  </div>
                </div>
              )}

              {["APPROVED","APPLIED"].includes(job.appStage) && (
                <div className="space-y-2">
                  <p className="text-[9px] font-semibold text-zinc-400 uppercase tracking-widest">Move to</p>
                  <div className="flex flex-wrap gap-1.5">
                    {["applied","interviewing","offer","closed"].map(a => (
                      <Button key={a} onClick={() => act(job.id, a)} disabled={acting}
                        variant="outline" size="sm" className="capitalize text-xs">
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
                    <p className="text-[9px] font-semibold text-zinc-400 uppercase tracking-widest mb-3">Outreach History</p>
                    <div className="space-y-3">
                      {job.outreaches!.map(o => (
                        <div key={o.id} className="flex gap-3 items-start">
                          <div className="w-1.5 h-1.5 rounded-full bg-zinc-300 mt-1.5 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-medium text-zinc-900 truncate">
                                {o.contact.name}
                                {o.contact.title && <span className="font-normal text-zinc-500"> · {o.contact.title}</span>}
                              </p>
                              <a href={o.contact.linkedinUrl} target="_blank" rel="noopener noreferrer"
                                className="text-[10px] text-blue-600 hover:underline shrink-0">LinkedIn →</a>
                            </div>
                            <p className="text-[10px] text-zinc-400 capitalize mt-0.5">{o.role.toLowerCase()}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* JD */}
              <Separator />
              <div>
                <p className="text-[9px] font-semibold text-zinc-400 uppercase tracking-widest mb-2">Job Description</p>
                <pre className="text-xs text-zinc-500 whitespace-pre-wrap font-sans leading-relaxed max-h-64 overflow-y-auto">
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
