"use client";

import { useEffect, useState, useCallback } from "react";
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

const STAGE_META: Record<AppStage, { label: string; accent: string; headerBorder: string; lane: string }> = {
  NEW:          { label:"New",          accent:"bg-zinc-400",    headerBorder:"border-l-zinc-300",    lane:"bg-white"         },
  APPROVED:     { label:"Approved",     accent:"bg-blue-500",    headerBorder:"border-l-blue-400",    lane:"bg-blue-50/40"    },
  SKIPPED:      { label:"Skipped",      accent:"bg-zinc-300",    headerBorder:"border-l-zinc-200",    lane:"bg-white"         },
  APPLIED:      { label:"Applied",      accent:"bg-violet-500",  headerBorder:"border-l-violet-400",  lane:"bg-violet-50/40"  },
  INTERVIEWING: { label:"Interviewing", accent:"bg-amber-500",   headerBorder:"border-l-amber-400",   lane:"bg-amber-50/40"   },
  OFFER:        { label:"Offer",        accent:"bg-emerald-500", headerBorder:"border-l-emerald-400", lane:"bg-emerald-50/40" },
  CLOSED:       { label:"Closed",       accent:"bg-red-400",     headerBorder:"border-l-red-300",     lane:"bg-red-50/30"     },
};

const SOURCE_LABEL: Record<string, string> = {
  LINKEDIN_JOB:"LinkedIn", LINKEDIN_POST:"LI Post", ADZUNA:"Adzuna",
  ATS_WATCHLIST:"Watchlist", REMOTIVE:"Remotive", REMOTEOK:"RemoteOK",
  JSEARCH:"JSearch", MANUAL:"Manual",
};

const OUTREACH_META: Record<string, { text: string; cls: string }> = {
  NONE:              { text:"",          cls:"" },
  INVITE_SENT:       { text:"Invite sent", cls:"text-blue-600 bg-blue-50 border-blue-200" },
  CONNECTED:         { text:"Connected",   cls:"text-blue-600 bg-blue-50 border-blue-200" },
  MESSAGED:          { text:"Messaged",    cls:"text-indigo-600 bg-indigo-50 border-indigo-200" },
  REPLIED:           { text:"Replied ✓",   cls:"text-emerald-700 bg-emerald-50 border-emerald-200" },
  NO_REPLY_ARCHIVED: { text:"No reply",    cls:"text-zinc-500 bg-zinc-100 border-zinc-200" },
};

// ─── Utils ────────────────────────────────────────────────────────────────────

const scoreClr = (n: number | null) =>
  n === null ? "bg-zinc-100 text-zinc-400" :
  n >= 80 ? "bg-green-100 text-green-800" :
  n >= 60 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-700";

const AVATAR_COLORS = [
  "bg-blue-100 text-blue-700","bg-violet-100 text-violet-700",
  "bg-emerald-100 text-emerald-700","bg-amber-100 text-amber-800",
  "bg-rose-100 text-rose-700","bg-cyan-100 text-cyan-700",
  "bg-indigo-100 text-indigo-700","bg-orange-100 text-orange-800",
];
const avatarClr = (name: string) => AVATAR_COLORS[name.charCodeAt(0) % 8];

const fmtSalary = (base: number | null, cur: string | null) =>
  !base ? null : new Intl.NumberFormat("en-IN", {
    style:"currency", currency: cur ?? "INR", maximumFractionDigits:0, notation:"compact",
  }).format(base);

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BoardPage() {
  const [jobs, setJobs]         = useState<Job[]>([]);
  const [loading, setLoading]   = useState(true);
  const [selected, setSelected] = useState<Job | null>(null);
  const [detail, setDetail]     = useState<Job | null>(null);
  const [copied, setCopied]     = useState(false);
  const [acting, setActing]     = useState(false);

  useEffect(() => {
    fetch("/api/jobs?limit=200").then(r => r.json())
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
    await fetch("/api/jobs/action", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ jobId, action }) });
    const updated = await fetch(`/api/jobs/${jobId}`).then(r => r.json()) as Job;
    setDetail(updated);
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, appStage: updated.appStage } : j));
    setActing(false);
  }, []);

  const byStage = STAGES.reduce<Record<string, Job[]>>((a,s) => { a[s]=[]; return a; }, {});
  for (const j of jobs) if (j.appStage !== "SKIPPED" && byStage[j.appStage]) byStage[j.appStage].push(j);

  const tw      = Date.now() - 7*24*60*60*1000;
  const replied = jobs.filter(j => j.outreachState === "REPLIED").length;
  const sent    = jobs.filter(j => j.outreachState !== "NONE").length;

  const stats = [
    { label:"Found this week", value: jobs.filter(j => new Date(j.createdAt).getTime() > tw).length, color:"text-zinc-900" },
    { label:"Approved",        value: jobs.filter(j => j.appStage === "APPROVED").length,             color:"text-blue-600" },
    { label:"Outreach sent",   value: sent,                                                            color:"text-indigo-600" },
    { label:"Replies",         value: replied,                                                         color:"text-emerald-600" },
    { label:"Applied",         value: jobs.filter(j => j.appStage === "APPLIED").length,              color:"text-violet-600" },
    { label:"Interviews",      value: jobs.filter(j => j.appStage === "INTERVIEWING").length,         color:"text-amber-600" },
    { label:"Response rate",   value: sent > 0 ? `${Math.round(replied/sent*100)}%` : "—",            color:"text-zinc-900" },
  ];

  const job = detail ?? selected;

  return (
    <div className="flex flex-col h-[calc(100vh-48px)] bg-zinc-100 overflow-hidden">

      {/* ── Stats + Controls ──────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-8 pt-6 pb-4 space-y-4">

        {/* Stat cards */}
        <div className="grid grid-cols-7 gap-3">
          {stats.map(({ label, value, color }) => (
            <div key={label} className="bg-white rounded-xl border border-zinc-200 shadow-sm px-4 py-3.5">
              <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest mb-1">{label}</p>
              <p className={`text-2xl font-bold tabular-nums ${loading ? "text-zinc-200 animate-pulse" : color}`}>
                {loading ? "0" : value}
              </p>
            </div>
          ))}
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-2">
          {["Source: All","Apply type: All","Score: All"].map(label => (
            <select key={label} className="text-xs border border-zinc-200 rounded-lg px-3 py-2 bg-white text-zinc-600 shadow-sm focus:outline-none focus:border-zinc-400 cursor-pointer">
              <option>{label}</option>
            </select>
          ))}
          <div className="ml-auto flex items-center gap-1 text-xs text-zinc-400">
            <span className="mr-1 font-medium">Sort:</span>
            {["Score","Salary","Date"].map(s => (
              <button key={s} className="px-2.5 py-1.5 rounded-lg hover:bg-white hover:text-zinc-700 hover:shadow-sm transition-all">{s}</button>
            ))}
          </div>
          <a href="/add"
            className="ml-2 bg-zinc-900 hover:bg-zinc-700 text-white text-xs font-semibold px-4 py-2 rounded-lg shadow-sm transition-colors">
            + Add Job
          </a>
        </div>
      </div>

      {/* ── Kanban ────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden px-8 pb-8">
        {/* White board container */}
        <div className="flex h-full rounded-2xl border border-zinc-200 shadow-sm bg-white overflow-hidden min-w-max">
          {STAGES.map((stage, i) => {
            const meta  = STAGE_META[stage];
            const cards = byStage[stage];
            const isLast = i === STAGES.length - 1;
            return (
              <div key={stage} className={`w-[272px] flex-shrink-0 flex flex-col ${!isLast ? "border-r border-zinc-100" : ""}`}>

                {/* Column header */}
                <div className={`flex-shrink-0 flex items-center gap-2.5 px-5 py-4 border-b border-zinc-100 border-l-[3px] ${meta.headerBorder} bg-white`}>
                  <div className={`w-2 h-2 rounded-full shrink-0 ${meta.accent}`} />
                  <span className="text-sm font-semibold text-zinc-800">{meta.label}</span>
                  <span className="ml-auto text-xs font-semibold text-zinc-400 tabular-nums bg-zinc-100 rounded-full px-2 py-0.5 min-w-[24px] text-center">
                    {cards.length}
                  </span>
                </div>

                {/* Cards */}
                <div className={`flex-1 overflow-y-auto p-4 space-y-3 ${meta.lane}`}>
                  {loading && (
                    <>
                      <div className="bg-zinc-100 rounded-xl h-24 animate-pulse" />
                      <div className="bg-zinc-100 rounded-xl h-20 animate-pulse opacity-60" />
                    </>
                  )}
                  {!loading && cards.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-20 rounded-xl border-2 border-dashed border-zinc-200">
                      <p className="text-xs text-zinc-300 font-medium">No jobs</p>
                    </div>
                  )}
                  {cards.map(job => {
                    const sal     = fmtSalary(job.salaryAnnualBase, job.salaryCurrency);
                    const outreach = OUTREACH_META[job.outreachState];
                    return (
                      <button key={job.id} onClick={() => openJob(job)}
                        className="w-full text-left bg-white rounded-xl p-4 border border-zinc-200 hover:border-zinc-300 hover:shadow-md active:scale-[0.99] transition-all shadow-sm">

                        <div className="flex items-start gap-3 mb-3">
                          <Avatar className={`h-8 w-8 rounded-xl shrink-0 ${avatarClr(job.company)}`}>
                            <AvatarFallback className={`rounded-xl text-xs font-bold ${avatarClr(job.company)}`}>
                              {job.company.charAt(0).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-zinc-900 truncate leading-tight">{job.company}</p>
                            <p className="text-xs text-zinc-500 truncate mt-0.5 leading-tight">{job.role}</p>
                          </div>
                          {job.aiScore !== null && (
                            <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-lg shrink-0 ${scoreClr(job.aiScore)}`}>
                              {job.aiScore}
                            </span>
                          )}
                        </div>

                        {sal && (
                          <p className={`text-xs font-semibold mb-2.5 ${job.salaryBasis === "ESTIMATED" ? "text-amber-600" : "text-emerald-600"}`}>
                            {sal}/yr
                            <span className="text-zinc-400 font-normal ml-1.5">
                              {job.salaryBasis === "STATED" ? "· stated" : "· est."}
                            </span>
                          </p>
                        )}

                        <div className="flex flex-wrap gap-1.5">
                          <span className="text-[10px] text-zinc-500 bg-zinc-100 rounded-md px-2 py-1 font-medium">
                            {SOURCE_LABEL[job.source] ?? job.source}
                          </span>
                          {job.applyType === "REFERRAL_FIRST" && (
                            <span className="text-[10px] text-violet-700 bg-violet-100 rounded-md px-2 py-1 font-medium">
                              Referral
                            </span>
                          )}
                          {outreach.text && (
                            <span className={`text-[10px] border rounded-md px-2 py-1 font-medium ${outreach.cls}`}>
                              {outreach.text}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Job Drawer ────────────────────────────────────────────────── */}
      <Sheet open={!!selected} onOpenChange={v => { if (!v) { setSelected(null); setDetail(null); } }}>
        <SheetContent className="!w-[500px] !max-w-[500px] p-0 flex flex-col bg-white" showCloseButton>

          <SheetHeader className="px-6 pt-6 pb-5 border-b border-zinc-100 flex-shrink-0">
            <div className="flex items-start gap-3 pr-8">
              {job && (
                <Avatar className={`h-10 w-10 rounded-xl shrink-0 ${avatarClr(job.company)}`}>
                  <AvatarFallback className={`rounded-xl font-bold text-sm ${avatarClr(job.company)}`}>
                    {job.company.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-bold text-base text-zinc-900 leading-tight">{job?.company}</p>
                    <p className="text-sm text-zinc-500 mt-0.5">{job?.role}</p>
                    {job?.location && <p className="text-xs text-zinc-400 mt-0.5">{job.location}</p>}
                  </div>
                  {job?.aiScore !== null && job?.aiScore !== undefined && (
                    <div className={`shrink-0 text-center px-3 py-1.5 rounded-xl ${scoreClr(job.aiScore)}`}>
                      <p className="text-xl font-bold leading-none">{job.aiScore}</p>
                      <p className="text-[9px] font-semibold uppercase tracking-widest mt-0.5 opacity-50">score</p>
                    </div>
                  )}
                </div>
                {job && (
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    <span className="text-[10px] bg-zinc-100 text-zinc-600 rounded-md px-2 py-1 font-medium">
                      {STAGE_META[job.appStage].label}
                    </span>
                    <span className="text-[10px] bg-zinc-100 text-zinc-500 rounded-md px-2 py-1">
                      {SOURCE_LABEL[job.source] ?? job.source}
                    </span>
                    {job.applyType === "REFERRAL_FIRST" && (
                      <span className="text-[10px] bg-violet-100 text-violet-700 rounded-md px-2 py-1 font-medium">Referral First</span>
                    )}
                    {job.outreachState !== "NONE" && OUTREACH_META[job.outreachState].text && (
                      <span className={`text-[10px] border rounded-md px-2 py-1 font-medium ${OUTREACH_META[job.outreachState].cls}`}>
                        {OUTREACH_META[job.outreachState].text}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </SheetHeader>

          {job && (
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

              {job.aiReason && (
                <div>
                  <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest mb-2">✦ AI Analysis</p>
                  <p className="text-sm text-zinc-700 leading-relaxed">{job.aiReason}</p>
                </div>
              )}

              {job.tailoredPitch && (
                <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2.5">
                    <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest">Generated Pitch</p>
                    <button
                      onClick={() => { navigator.clipboard.writeText(job.tailoredPitch!); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                      className="text-xs font-medium text-zinc-400 hover:text-zinc-700 transition-colors">
                      {copied ? "Copied ✓" : "Copy"}
                    </button>
                  </div>
                  <p className="text-sm text-zinc-700 leading-relaxed italic whitespace-pre-line">
                    &ldquo;{job.tailoredPitch}&rdquo;
                  </p>
                </div>
              )}

              <Separator className="bg-zinc-100" />

              {/* Salary + Apply */}
              <div className="flex items-center justify-between">
                <div>
                  {job.salaryAnnualBase ? (
                    <>
                      <p className={`text-xl font-bold ${job.salaryBasis === "ESTIMATED" ? "text-amber-700" : "text-zinc-900"}`}>
                        {fmtSalary(job.salaryAnnualBase, job.salaryCurrency)}/yr
                      </p>
                      <p className="text-xs text-zinc-400 mt-0.5">
                        {job.salaryBasis === "STATED" ? "Stated salary" : `Estimated · ${job.salaryConfidence?.toLowerCase() ?? "low"} confidence`}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-zinc-400">Salary unknown</p>
                  )}
                </div>
                {job.applyUrl && (
                  <a href={job.applyUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold px-4 py-2 rounded-xl shadow-sm transition-colors">
                    ↗ Apply
                  </a>
                )}
              </div>

              <Separator className="bg-zinc-100" />

              {job.appStage === "NEW" && (
                <div className="space-y-2">
                  <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest">Actions</p>
                  <div className="flex gap-2">
                    <Button onClick={() => act(job.id,"approve")} disabled={acting} size="sm"
                      className="flex-1 bg-zinc-900 hover:bg-zinc-800 text-white text-xs h-9">
                      ✓ Approve &amp; Queue Outreach
                    </Button>
                    <Button onClick={() => act(job.id,"skip")} disabled={acting} variant="outline" size="sm" className="text-xs h-9">
                      Skip
                    </Button>
                  </div>
                </div>
              )}

              {["APPROVED","APPLIED"].includes(job.appStage) && (
                <div className="space-y-2">
                  <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest">Move to stage</p>
                  <div className="flex flex-wrap gap-2">
                    {["applied","interviewing","offer","closed"].map(a => (
                      <Button key={a} onClick={() => act(job.id, a)} disabled={acting}
                        variant="outline" size="sm" className="capitalize text-xs h-9">
                        {a}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {(job.outreaches?.length ?? 0) > 0 && (
                <>
                  <Separator className="bg-zinc-100" />
                  <div>
                    <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest mb-3">Outreach History</p>
                    <div className="space-y-3">
                      {job.outreaches!.map(o => (
                        <div key={o.id} className="flex gap-3 items-start p-3 bg-zinc-50 rounded-xl border border-zinc-100">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-semibold text-zinc-900 truncate">
                                {o.contact.name}
                                {o.contact.title && <span className="font-normal text-zinc-500"> · {o.contact.title}</span>}
                              </p>
                              <a href={o.contact.linkedinUrl} target="_blank" rel="noopener noreferrer"
                                className="text-[10px] font-medium text-blue-600 hover:underline shrink-0">LinkedIn →</a>
                            </div>
                            <p className="text-[10px] text-zinc-400 capitalize mt-0.5">{o.role.toLowerCase()}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              <Separator className="bg-zinc-100" />
              <div>
                <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest mb-3">Job Description</p>
                <pre className="text-xs text-zinc-500 whitespace-pre-wrap font-sans leading-relaxed max-h-72 overflow-y-auto bg-zinc-50 rounded-xl p-4 border border-zinc-100">
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
