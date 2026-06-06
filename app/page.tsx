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
const STAGE_LABEL: Record<AppStage, string> = {
  NEW:"New", APPROVED:"Approved", SKIPPED:"Skipped",
  APPLIED:"Applied", INTERVIEWING:"Interviewing", OFFER:"Offer", CLOSED:"Closed",
};
const STAGE_BG: Record<AppStage, string> = {
  NEW:"bg-zinc-50", APPROVED:"bg-blue-50/60", SKIPPED:"bg-zinc-50",
  APPLIED:"bg-violet-50/60", INTERVIEWING:"bg-amber-50/60", OFFER:"bg-emerald-50/60", CLOSED:"bg-red-50/60",
};
const SOURCE_LABEL: Record<string, string> = {
  LINKEDIN_JOB:"LinkedIn", LINKEDIN_POST:"LI Post", ADZUNA:"Adzuna",
  ATS_WATCHLIST:"Watchlist", REMOTIVE:"Remotive", REMOTEOK:"RemoteOK",
  JSEARCH:"JSearch", MANUAL:"Manual",
};
const OUTREACH_LABEL: Record<string, { text: string; cls: string }> = {
  NONE:               { text: "", cls: "" },
  INVITE_SENT:        { text: "Invite sent",  cls: "bg-blue-50 text-blue-700 border-blue-200" },
  CONNECTED:          { text: "Connected",    cls: "bg-blue-50 text-blue-700 border-blue-200" },
  MESSAGED:           { text: "Messaged",     cls: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  REPLIED:            { text: "Replied ✓",    cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  NO_REPLY_ARCHIVED:  { text: "No reply",     cls: "bg-zinc-100 text-zinc-500 border-zinc-200" },
};

// ─── Utils ────────────────────────────────────────────────────────────────────

const scoreClr = (n: number | null) => n === null ? "bg-zinc-100 text-zinc-400" : n >= 80 ? "bg-green-100 text-green-800" : n >= 60 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700";

const avatarClr = (name: string) => ["bg-blue-100 text-blue-700","bg-violet-100 text-violet-700","bg-emerald-100 text-emerald-700","bg-amber-100 text-amber-700","bg-rose-100 text-rose-700","bg-cyan-100 text-cyan-700","bg-indigo-100 text-indigo-700","bg-orange-100 text-orange-700"][name.charCodeAt(0) % 8];

const fmtSalary = (base: number | null, cur: string | null) => !base ? null :
  new Intl.NumberFormat("en-IN", { style:"currency", currency: cur??"INR", maximumFractionDigits:0, notation:"compact" }).format(base);

// ─── Board ────────────────────────────────────────────────────────────────────

export default function BoardPage() {
  const [jobs, setJobs]       = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Job | null>(null);
  const [detail, setDetail]   = useState<Job | null>(null);
  const [copied, setCopied]   = useState(false);
  const [acting, setActing]   = useState(false);

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

  const closeJob = () => { setSelected(null); setDetail(null); };

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

  const job = detail ?? selected;

  return (
    <div className="px-6 py-5 space-y-4">

      {/* ── Stats ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-7 gap-3">
        {stats.map(([label, val]) => (
          <div key={label} className="bg-white rounded-xl border border-zinc-200 px-4 py-3">
            <p className="text-[10px] font-medium text-zinc-400 uppercase tracking-widest">{label}</p>
            <p className="text-2xl font-bold text-zinc-900 mt-0.5 tabular-nums">{loading ? "—" : val}</p>
          </div>
        ))}
      </div>

      {/* ── Filter bar ────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        {["Source: All", "Apply: All", "Score: All"].map(label => (
          <select key={label} className="text-xs border border-zinc-200 rounded-lg px-3 py-1.5 bg-white text-zinc-600 focus:outline-none">
            <option>{label}</option>
          </select>
        ))}
        <div className="ml-auto flex items-center gap-1 text-xs text-zinc-400">
          Sort by:
          {["Score","Salary","Date"].map(s => (
            <button key={s} className="px-2 py-1 rounded hover:bg-white hover:text-zinc-700 transition-colors">{s}</button>
          ))}
        </div>
      </div>

      {/* ── Kanban ────────────────────────────────────────────────────── */}
      <div className="flex gap-3 overflow-x-auto pb-4">
        {STAGES.map(stage => (
          <div key={stage} className="w-[255px] flex-shrink-0 flex flex-col gap-2">

            {/* Column header */}
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-zinc-800">{STAGE_LABEL[stage]}</span>
              <span className="text-xs font-medium text-zinc-400 bg-zinc-100 rounded-full px-2 py-0.5 tabular-nums">
                {byStage[stage].length}
              </span>
            </div>

            {/* Lane */}
            <div className={`rounded-xl p-2 min-h-28 flex flex-col gap-2 ${STAGE_BG[stage]}`}>
              {loading && <p className="m-auto text-xs text-zinc-400">Loading…</p>}
              {!loading && byStage[stage].length === 0 && (
                <p className="m-auto text-xs text-zinc-400">Empty</p>
              )}

              {byStage[stage].map(job => {
                const sal = fmtSalary(job.salaryAnnualBase, job.salaryCurrency);
                const outreach = OUTREACH_LABEL[job.outreachState];
                return (
                  <button key={job.id} onClick={() => openJob(job)}
                    className="w-full text-left bg-white rounded-lg p-3 border border-zinc-200/80 hover:border-zinc-300 hover:shadow-sm active:scale-[0.99] transition-all">

                    {/* Header */}
                    <div className="flex items-start gap-2 mb-2">
                      <Avatar className={`h-7 w-7 rounded-lg shrink-0 text-xs ${avatarClr(job.company)}`}>
                        <AvatarFallback className={`rounded-lg text-xs font-bold ${avatarClr(job.company)}`}>
                          {job.company.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-zinc-900 truncate leading-tight">{job.company}</p>
                        <p className="text-xs text-zinc-500 truncate leading-tight mt-0.5">{job.role}</p>
                      </div>
                      {job.aiScore !== null && (
                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded-md shrink-0 ${scoreClr(job.aiScore)}`}>
                          {job.aiScore}
                        </span>
                      )}
                    </div>

                    {/* Salary */}
                    {sal && (
                      <p className={`text-xs font-medium mb-1.5 ${job.salaryBasis === "ESTIMATED" ? "text-amber-600" : "text-emerald-600"}`}>
                        {sal}/yr · <span className="font-normal text-zinc-400">{job.salaryBasis === "STATED" ? "stated" : "est."}</span>
                        {job.salaryFlagReason && " ⚠"}
                      </p>
                    )}

                    {/* Chips */}
                    <div className="flex flex-wrap gap-1">
                      <span className="text-[10px] text-zinc-500 border border-zinc-200 rounded-md px-1.5 py-0.5">
                        {SOURCE_LABEL[job.source] ?? job.source}
                      </span>
                      {job.applyType === "REFERRAL_FIRST" && (
                        <span className="text-[10px] text-violet-600 border border-violet-200 bg-violet-50 rounded-md px-1.5 py-0.5">
                          Referral
                        </span>
                      )}
                      {job.outreachState !== "NONE" && outreach.text && (
                        <span className={`text-[10px] border rounded-md px-1.5 py-0.5 ${outreach.cls}`}>
                          {outreach.text}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ── Job Drawer ────────────────────────────────────────────────── */}
      <Sheet open={!!selected} onOpenChange={v => { if (!v) closeJob(); }}>
        <SheetContent
          className="!w-[500px] !max-w-[500px] overflow-y-auto p-0 flex flex-col"
          showCloseButton
        >
          {/* Header */}
          <SheetHeader className="px-6 pt-5 pb-4 border-b border-zinc-200 flex-shrink-0">
            <div className="flex items-start gap-3">
              {job && (
                <Avatar className={`h-10 w-10 rounded-xl shrink-0 ${avatarClr(job.company)}`}>
                  <AvatarFallback className={`rounded-xl font-bold text-sm ${avatarClr(job.company)}`}>
                    {job.company.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              )}
              <div className="flex-1 min-w-0 pr-8">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-bold text-base leading-tight truncate">
                      {job?.company} · {job?.role}
                    </p>
                    {job?.location && <p className="text-xs text-zinc-500 mt-0.5">{job.location}</p>}
                  </div>
                  {job?.aiScore !== null && job?.aiScore !== undefined && (
                    <div className="text-right shrink-0">
                      <p className={`text-2xl font-bold ${scoreClr(job.aiScore).split(" ")[1]}`}>{job.aiScore}</p>
                      <p className="text-[9px] text-zinc-400 uppercase tracking-widest">AI Score</p>
                    </div>
                  )}
                </div>

                {/* Status row */}
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {job && (
                    <>
                      <span className="text-[10px] border border-zinc-200 rounded-md px-2 py-0.5 text-zinc-600">{STAGE_LABEL[job.appStage]}</span>
                      <span className="text-[10px] border border-zinc-200 rounded-md px-2 py-0.5 text-zinc-500">{SOURCE_LABEL[job.source] ?? job.source}</span>
                      {job.applyType === "REFERRAL_FIRST" && (
                        <span className="text-[10px] border border-violet-200 bg-violet-50 text-violet-700 rounded-md px-2 py-0.5">Referral First</span>
                      )}
                      {job.outreachState !== "NONE" && OUTREACH_LABEL[job.outreachState].text && (
                        <span className={`text-[10px] border rounded-md px-2 py-0.5 ${OUTREACH_LABEL[job.outreachState].cls}`}>
                          {OUTREACH_LABEL[job.outreachState].text}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </SheetHeader>

          {/* Body */}
          {job && (
            <div className="px-6 py-5 space-y-5 flex-1 overflow-y-auto">

              {/* AI Analysis */}
              {job.aiReason && (
                <div>
                  <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest mb-1.5">✦ AI Analysis</p>
                  <p className="text-sm text-zinc-700 leading-relaxed">{job.aiReason}</p>
                </div>
              )}

              {/* Pitch */}
              {job.tailoredPitch && (
                <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest">Generated Pitch</p>
                    <button
                      onClick={() => { navigator.clipboard.writeText(job.tailoredPitch!); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                      className="text-xs text-zinc-400 hover:text-zinc-700 transition-colors"
                    >
                      {copied ? "Copied ✓" : "Copy"}
                    </button>
                  </div>
                  <p className="text-sm text-zinc-700 leading-relaxed italic whitespace-pre-line">
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
                      <p className={`text-xl font-bold ${job.salaryBasis === "ESTIMATED" ? "text-amber-700" : "text-zinc-900"}`}>
                        {fmtSalary(job.salaryAnnualBase, job.salaryCurrency)}/yr
                      </p>
                      <p className="text-xs text-zinc-400 mt-0.5">
                        {job.salaryBasis === "STATED" ? "Stated" : `Estimated · ${job.salaryConfidence?.toLowerCase() ?? ""} confidence`}
                      </p>
                      {job.salaryFlagReason && <p className="text-xs text-amber-600 mt-0.5">⚠ {job.salaryFlagReason.replace(/_/g," ")}</p>}
                    </>
                  ) : (
                    <p className="text-sm text-zinc-400">Salary unknown</p>
                  )}
                </div>
                {job.applyUrl && (
                  <a href={job.applyUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
                    ↗ Apply
                  </a>
                )}
              </div>

              <Separator />

              {/* Actions */}
              {job.appStage === "NEW" && (
                <div className="space-y-2">
                  <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest">Actions</p>
                  <div className="flex gap-2">
                    <Button onClick={() => act(job.id, "approve")} disabled={acting}
                      className="flex-1 bg-zinc-900 hover:bg-zinc-800 text-white text-sm">
                      ✓ Approve &amp; Queue Outreach
                    </Button>
                    <Button onClick={() => act(job.id, "skip")} disabled={acting} variant="outline" className="text-sm">
                      Skip
                    </Button>
                  </div>
                </div>
              )}

              {["APPROVED","APPLIED"].includes(job.appStage) && (
                <div className="space-y-2">
                  <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest">Update Stage</p>
                  <div className="flex flex-wrap gap-2">
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
                    <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest mb-3">Outreach History</p>
                    <div className="space-y-3">
                      {job.outreaches!.map(o => (
                        <div key={o.id} className="flex items-start gap-3">
                          <div className="mt-2 w-1.5 h-1.5 rounded-full bg-zinc-300 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-medium text-zinc-900 truncate">
                                {o.contact.name}
                                {o.contact.title && <span className="font-normal text-zinc-500"> · {o.contact.title}</span>}
                              </p>
                              <a href={o.contact.linkedinUrl} target="_blank" rel="noopener noreferrer"
                                className="text-xs text-blue-600 hover:underline shrink-0">LinkedIn →</a>
                            </div>
                            <p className="text-xs text-zinc-400 capitalize">{o.role.toLowerCase()}</p>
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
                <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest mb-2">Job Description</p>
                <pre className="text-xs text-zinc-500 whitespace-pre-wrap font-sans leading-relaxed max-h-72 overflow-y-auto pr-1">
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
