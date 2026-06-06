"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
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
  needsTailoring: boolean; tailoringSuggestions: string | null; tailoredResumeKey: string | null;
  outreaches?: Array<{
    id: string; role: string;
    contact: { name: string; title: string | null; linkedinUrl: string };
    thread?: {
      id: string; status: string;
      providerState: { phase?: string; connectionNote?: string; firstDm?: string; followup?: string } | null;
      archivedReason: string | null;
    } | null;
  }>;
};

type DraftEdit = { connectionNote: string; firstDm: string; followup: string };

const THREAD_PHASE_LABEL: Record<string, string> = {
  QUEUED:         "Queued — invite sends next tick",
  INVITE_PENDING: "Invite sent — awaiting acceptance",
  CONNECTED:      "Connected — DM sends next tick",
  MESSAGED:       "Messaged — awaiting reply",
  REPLIED:        "Replied 🎉",
};

// ─── Config ───────────────────────────────────────────────────────────────────

const STAGES: AppStage[] = ["NEW","APPROVED","OUTREACH","REPLIED"];

const STAGE_META: Record<AppStage, { label: string; accent: string; headerBorder: string; lane: string }> = {
  NEW:      { label:"New",      accent:"bg-zinc-400",    headerBorder:"border-l-zinc-300",    lane:"bg-white"         },
  APPROVED: { label:"Approved", accent:"bg-blue-500",    headerBorder:"border-l-blue-400",    lane:"bg-blue-50/40"    },
  OUTREACH: { label:"Outreach", accent:"bg-indigo-500",  headerBorder:"border-l-indigo-400",  lane:"bg-indigo-50/40"  },
  REPLIED:  { label:"Replied",  accent:"bg-emerald-500", headerBorder:"border-l-emerald-400", lane:"bg-emerald-50/40" },
  SKIPPED:  { label:"Skipped",  accent:"bg-zinc-300",    headerBorder:"border-l-zinc-200",    lane:"bg-white"         },
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
  const [uploadingResume, setUploadingResume] = useState(false);
  const resumeFileRef = useRef<HTMLInputElement>(null);
  const [sel, setSel]       = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [askNote, setAskNote] = useState(false);
  const [toast, setToast]   = useState<{ msg: string; tone: "info" | "warn" | "error" } | null>(null);
  const showToast = useCallback((msg: string, tone: "info" | "warn" | "error" = "info") => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 4500);
  }, []);
  const toggleSel = (id: string) => setSel(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const sendSelected = async (withNote: boolean) => {
    if (sel.size === 0) return;
    setSending(true);
    setAskNote(false);
    const jobIds = [...sel];
    const res = await fetch("/api/outreach/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobIds, withNote }) }).then(r => r.json()).catch(() => null);
    setSending(false);
    setSel(new Set());
    const d = await fetch("/api/jobs?limit=200").then(r => r.json()).catch(() => null);
    if (d?.jobs) setJobs(d.jobs);
    if (res?.paused) showToast("Outreach is paused — turn it back on in Settings → Outreach.", "error");
    else if (res?.capped) showToast("Daily/weekly send cap hit. The rest go out automatically in the next window.", "warn");
    else if (res?.noThreads) showToast("Nothing to send for the selected jobs.", "info");
    else if (typeof res?.sent === "number") showToast(`Sent ${res.sent} request${res.sent !== 1 ? "s" : ""}.`, "info");
  };

  // Filters + sort (client-side over the loaded jobs)
  const [fSource, setFSource] = useState("All");
  const [fApply, setFApply]   = useState("All");
  const [fScore, setFScore]   = useState("All");
  const [sort, setSort]       = useState<"Score" | "Salary" | "Date">("Date");

  // Editable outreach drafts for the open job, keyed by threadId
  const [drafts, setDrafts] = useState<Record<string, DraftEdit>>({});

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
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, appStage: updated.appStage, outreachState: updated.outreachState } : j));
    setActing(false);
  }, []);

  // Initialise editable drafts whenever the open job's detail loads.
  useEffect(() => {
    if (!detail?.outreaches) { setDrafts({}); return; }
    const init: Record<string, DraftEdit> = {};
    for (const o of detail.outreaches) {
      const t = o.thread;
      const ps = t?.providerState;
      if (t && t.status === "PENDING" && ps?.phase === "DRAFT") {
        init[t.id] = { connectionNote: ps.connectionNote ?? "", firstDm: ps.firstDm ?? "", followup: ps.followup ?? "" };
      }
    }
    setDrafts(init);
  }, [detail]);

  const confirmOutreach = useCallback(async (jobId: string, threadId: string, action: "send" | "cancel") => {
    setActing(true);
    const edits = drafts[threadId] ?? {};
    await fetch("/api/outreach/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, action, ...edits }),
    });
    const updated = await fetch(`/api/jobs/${jobId}`).then(r => r.json()) as Job;
    setDetail(updated);
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, outreachState: updated.outreachState } : j));
    setActing(false);
  }, [drafts]);

  const uploadTailored = useCallback(async (jobId: string, file: File) => {
    setUploadingResume(true);
    const fd = new FormData();
    fd.append("file", file);
    await fetch(`/api/resume/tailored?jobId=${jobId}`, { method: "POST", body: fd });
    const updated = await fetch(`/api/jobs/${jobId}`).then(r => r.json()) as Job;
    setDetail(updated);
    setUploadingResume(false);
  }, []);

  // Distinct sources present (for the Source filter options)
  const sourceOptions = useMemo(
    () => Array.from(new Set(jobs.map(j => j.source))),
    [jobs],
  );

  const visible = useMemo(() => {
    const v = jobs.filter(j => {
      if (fSource !== "All" && j.source !== fSource) return false;
      if (fApply === "Referral" && j.applyType !== "REFERRAL_FIRST") return false;
      if (fApply === "Manual" && j.applyType !== "MANUAL_NOTIFY") return false;
      if (fScore === "80+" && (j.aiScore ?? 0) < 80) return false;
      if (fScore === "60+" && (j.aiScore ?? 0) < 60) return false;
      if (fScore === "<60" && (j.aiScore ?? 0) >= 60) return false;
      return true;
    });
    v.sort((a, b) => {
      if (sort === "Score")  return (b.aiScore ?? -1) - (a.aiScore ?? -1);
      if (sort === "Salary") return (b.salaryAnnualBase ?? -1) - (a.salaryAnnualBase ?? -1);
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return v;
  }, [jobs, fSource, fApply, fScore, sort]);

  const byStage = STAGES.reduce<Record<string, Job[]>>((a,s) => { a[s]=[]; return a; }, {});
  for (const j of visible) if (j.appStage !== "SKIPPED" && byStage[j.appStage]) byStage[j.appStage].push(j);

  const tw      = Date.now() - 7*24*60*60*1000;
  const replied = jobs.filter(j => j.outreachState === "REPLIED").length;
  const sent    = jobs.filter(j => j.outreachState !== "NONE").length;

  const stats = [
    { label:"Found this week", value: jobs.filter(j => j.appStage !== "SKIPPED" && new Date(j.createdAt).getTime() > tw).length, color:"text-zinc-900" },
    { label:"Approved",        value: jobs.filter(j => j.appStage === "APPROVED").length,             color:"text-blue-600" },
    { label:"Outreach sent",   value: sent,                                                            color:"text-indigo-600" },
    { label:"Replies",         value: replied,                                                         color:"text-emerald-600" },
    { label:"In outreach",     value: jobs.filter(j => j.appStage === "OUTREACH").length,             color:"text-indigo-600" },
    { label:"Replied",         value: jobs.filter(j => j.appStage === "REPLIED").length,              color:"text-emerald-600" },
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
          <select value={fSource} onChange={e => setFSource(e.target.value)}
            className="text-xs border border-zinc-200 rounded-lg px-3 py-2 bg-white text-zinc-600 shadow-sm focus:outline-none focus:border-zinc-400 cursor-pointer">
            <option value="All">Source: All</option>
            {sourceOptions.map(src => <option key={src} value={src}>{SOURCE_LABEL[src] ?? src}</option>)}
          </select>
          <select value={fApply} onChange={e => setFApply(e.target.value)}
            className="text-xs border border-zinc-200 rounded-lg px-3 py-2 bg-white text-zinc-600 shadow-sm focus:outline-none focus:border-zinc-400 cursor-pointer">
            <option value="All">Apply type: All</option>
            <option value="Referral">Referral first</option>
            <option value="Manual">Manual apply</option>
          </select>
          <select value={fScore} onChange={e => setFScore(e.target.value)}
            className="text-xs border border-zinc-200 rounded-lg px-3 py-2 bg-white text-zinc-600 shadow-sm focus:outline-none focus:border-zinc-400 cursor-pointer">
            <option value="All">Score: All</option>
            <option value="80+">Score: 80+</option>
            <option value="60+">Score: 60+</option>
            <option value="<60">Score: &lt;60</option>
          </select>
          {(fSource !== "All" || fApply !== "All" || fScore !== "All") && (
            <button onClick={() => { setFSource("All"); setFApply("All"); setFScore("All"); }}
              className="text-xs text-zinc-400 hover:text-zinc-700 px-2 py-1.5 transition-colors">Clear</button>
          )}
          <div className="ml-auto flex items-center gap-1 text-xs text-zinc-400">
            <span className="mr-1 font-medium">Sort:</span>
            {(["Score","Salary","Date"] as const).map(sortKey => (
              <button key={sortKey} onClick={() => setSort(sortKey)}
                className={`px-2.5 py-1.5 rounded-lg transition-all ${sort === sortKey ? "bg-white text-zinc-900 shadow-sm font-medium" : "hover:bg-white hover:text-zinc-700 hover:shadow-sm"}`}>
                {sortKey}
              </button>
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
        <div className="flex h-full w-full rounded-2xl border border-zinc-200 shadow-sm bg-white overflow-hidden">
          {STAGES.map((stage, i) => {
            const meta  = STAGE_META[stage];
            const cards = byStage[stage];
            const isLast = i === STAGES.length - 1;
            return (
              <div key={stage} className={`flex-1 min-w-[220px] flex flex-col ${!isLast ? "border-r border-zinc-100" : ""}`}>

                {/* Column header */}
                <div className={`flex-shrink-0 flex items-center gap-2.5 px-5 py-4 border-b border-zinc-100 border-l-[3px] ${meta.headerBorder} bg-white`}>
                  <div className={`w-2 h-2 rounded-full shrink-0 ${meta.accent}`} />
                  <span className="text-sm font-semibold text-zinc-800">{meta.label}</span>
                  <span className="ml-auto text-xs font-semibold text-zinc-400 tabular-nums bg-zinc-100 rounded-full px-2 py-0.5 min-w-[24px] text-center">
                    {cards.length}
                  </span>
                  {stage === "APPROVED" && cards.length > 0 && (
                    <button
                      onClick={() => setSel(prev => {
                        const ids = cards.map(c => c.id);
                        const allSel = ids.every(id => prev.has(id));
                        const n = new Set(prev);
                        ids.forEach(id => allSel ? n.delete(id) : n.add(id));
                        return n;
                      })}
                      className="text-[11px] text-zinc-400 hover:text-zinc-700 font-medium ml-1"
                    >
                      {cards.every(c => sel.has(c.id)) ? "Clear" : "Select all"}
                    </button>
                  )}
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
                    const isSel = sel.has(job.id);
                    return (
                      <div key={job.id} className="relative group">
                      {job.appStage === "APPROVED" && (
                        <button onClick={(e) => { e.stopPropagation(); toggleSel(job.id); }}
                          className={`absolute top-2.5 right-2.5 z-10 w-5 h-5 rounded-md border flex items-center justify-center text-[11px] leading-none transition-all ${isSel ? "bg-zinc-900 border-zinc-900 text-white opacity-100" : "bg-white border-zinc-300 text-transparent hover:border-zinc-500 opacity-0 group-hover:opacity-100"}`}>
                          ✓
                        </button>
                      )}
                      <button onClick={() => openJob(job)}
                        className={`w-full text-left bg-white rounded-xl p-4 border hover:shadow-md active:scale-[0.99] transition-all shadow-sm ${isSel ? "border-zinc-900 ring-1 ring-zinc-900" : "border-zinc-200 hover:border-zinc-300"}`}>

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
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Toast ─────────────────────────────────────────────────────── */}
      {toast && (
        <div className={`fixed top-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg border animate-in fade-in slide-in-from-top-2 ${
          toast.tone === "error" ? "bg-red-50 border-red-200 text-red-700"
          : toast.tone === "warn" ? "bg-amber-50 border-amber-200 text-amber-800"
          : "bg-zinc-900 border-zinc-800 text-white"
        }`}>
          <span>{toast.tone === "error" ? "⛔" : toast.tone === "warn" ? "⚠" : "✓"}</span>
          {toast.msg}
          <button onClick={() => setToast(null)} className="ml-1 opacity-50 hover:opacity-100">×</button>
        </div>
      )}

      {/* ── Bulk send action bar ──────────────────────────────────────── */}
      {sel.size > 0 && !askNote && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-zinc-900 text-white rounded-full shadow-xl pl-5 pr-2 py-2">
          <span className="text-sm font-medium">{sel.size} selected</span>
          <button onClick={() => setSel(new Set())} className="text-xs text-zinc-300 hover:text-white">Clear</button>
          <button onClick={() => setAskNote(true)} disabled={sending}
            className="bg-white text-zinc-900 text-sm font-semibold rounded-full px-4 py-1.5 hover:bg-zinc-100 disabled:opacity-60 flex items-center gap-1.5">
            {sending ? "Sending…" : "Send requests →"}
          </button>
        </div>
      )}

      {/* Connection-note choice for the manual bulk send */}
      {sel.size > 0 && askNote && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-zinc-900 text-white rounded-2xl shadow-xl px-4 py-3">
          <span className="text-sm font-medium mr-1">Add a connection note to {sel.size} invite{sel.size !== 1 ? "s" : ""}?</span>
          <button onClick={() => sendSelected(true)} disabled={sending}
            className="bg-white text-zinc-900 text-sm font-semibold rounded-full px-4 py-1.5 hover:bg-zinc-100 disabled:opacity-60">
            With note
          </button>
          <button onClick={() => sendSelected(false)} disabled={sending}
            className="bg-zinc-700 text-white text-sm font-semibold rounded-full px-4 py-1.5 hover:bg-zinc-600 disabled:opacity-60">
            Without note
          </button>
          <button onClick={() => setAskNote(false)} disabled={sending}
            className="text-xs text-zinc-300 hover:text-white px-2">Cancel</button>
        </div>
      )}

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

              {/* Resume gate */}
              <div>
                <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest mb-2">Resume</p>
                {!job.needsTailoring ? (
                  <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2.5">
                    <span>✓</span> Base resume is a good fit — no tailoring needed.
                  </div>
                ) : job.tailoredResumeKey ? (
                  <div className="flex items-center justify-between gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2.5">
                    <span className="flex items-center gap-2">✓ Tailored resume uploaded</span>
                    <a href={`/api/resume/download?key=${encodeURIComponent(job.tailoredResumeKey)}`} target="_blank" rel="noopener noreferrer"
                      className="text-xs font-medium underline">View</a>
                  </div>
                ) : (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 space-y-2.5">
                    <p className="text-sm font-semibold text-amber-800">⚠ Tailoring recommended before outreach</p>
                    {job.tailoringSuggestions && (
                      <p className="text-xs text-amber-700 leading-relaxed whitespace-pre-line">{job.tailoringSuggestions}</p>
                    )}
                    <button
                      onClick={() => resumeFileRef.current?.click()}
                      disabled={uploadingResume}
                      className="text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-lg px-3 py-2 transition-colors">
                      {uploadingResume ? "Uploading…" : "↑ Upload tailored resume (PDF)"}
                    </button>
                    <input ref={resumeFileRef} type="file" accept="application/pdf" className="hidden"
                      onChange={e => { const f = e.target.files?.[0]; if (f) uploadTailored(job.id, f); }} />
                  </div>
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

              {["APPROVED","OUTREACH"].includes(job.appStage) && (
                <div className="space-y-2">
                  <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest">Manual override</p>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => act(job.id, "replied")} disabled={acting}
                      variant="outline" size="sm" className="text-xs h-9">Mark replied</Button>
                    <Button onClick={() => act(job.id, "skipped")} disabled={acting}
                      variant="outline" size="sm" className="text-xs h-9 text-red-600">Skip / stop</Button>
                  </div>
                </div>
              )}

              {(job.outreaches?.length ?? 0) > 0 && (
                <>
                  <Separator className="bg-zinc-100" />
                  <div>
                    <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest mb-3">Outreach</p>
                    <div className="space-y-3">
                      {job.outreaches!.map(o => {
                        const t = o.thread;
                        const ps = t?.providerState ?? {};
                        const phase = ps.phase ?? "DRAFT";
                        const isDraft = !!t && t.status === "PENDING" && phase === "DRAFT";
                        const edit = (t && drafts[t.id]) || { connectionNote: "", firstDm: "", followup: "" };
                        const label = t?.status === "ARCHIVED"
                          ? (t.archivedReason ?? "Archived")
                          : (THREAD_PHASE_LABEL[phase] ?? "");

                        return (
                          <div key={o.id} className="bg-zinc-50 rounded-xl border border-zinc-100 overflow-hidden">
                            <div className="flex gap-3 items-start p-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-xs font-semibold text-zinc-900 truncate">
                                    {o.contact.name}
                                    {o.contact.title && <span className="font-normal text-zinc-500"> · {o.contact.title}</span>}
                                  </p>
                                  <a href={o.contact.linkedinUrl} target="_blank" rel="noopener noreferrer"
                                    className="text-[10px] font-medium text-blue-600 hover:underline shrink-0">LinkedIn →</a>
                                </div>
                                <p className="text-[10px] text-zinc-400 mt-0.5">
                                  <span className="capitalize">{o.role.toLowerCase()}</span>
                                  {label && <span className="text-zinc-500"> · {label}</span>}
                                </p>
                              </div>
                            </div>

                            {isDraft && t && (
                              <div className="border-t border-zinc-200 bg-white p-3 space-y-2.5">
                                <p className="text-[10px] text-amber-600 font-medium">Review &amp; edit — nothing sends until you confirm.</p>
                                <DraftField label="Connection note (≤300)" rows={3} maxLength={300}
                                  value={edit.connectionNote}
                                  onChange={v => setDrafts(d => ({ ...d, [t.id]: { ...edit, connectionNote: v } }))} />
                                <DraftField label="First DM (after they accept)" rows={5}
                                  value={edit.firstDm}
                                  onChange={v => setDrafts(d => ({ ...d, [t.id]: { ...edit, firstDm: v } }))} />
                                <DraftField label="Follow-up (if no reply)" rows={3}
                                  value={edit.followup}
                                  onChange={v => setDrafts(d => ({ ...d, [t.id]: { ...edit, followup: v } }))} />
                                <div className="flex gap-2 pt-0.5">
                                  <Button onClick={() => confirmOutreach(job.id, t.id, "send")} disabled={acting} size="sm"
                                    className="flex-1 bg-zinc-900 hover:bg-zinc-800 text-white text-xs h-9">
                                    ✓ Confirm &amp; Send
                                  </Button>
                                  <Button onClick={() => confirmOutreach(job.id, t.id, "cancel")} disabled={acting}
                                    variant="outline" size="sm" className="text-xs h-9">Cancel</Button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}

              {job.appStage === "APPROVED" && job.applyType === "REFERRAL_FIRST" && (job.outreaches?.length ?? 0) === 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-700">
                  Approved — no LinkedIn targets were found for this role yet. You can still apply directly via the link above.
                </div>
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

function DraftField({ label, value, rows, maxLength, onChange }: {
  label: string; value: string; rows: number; maxLength?: number; onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide">{label}</label>
      <textarea
        value={value}
        rows={rows}
        maxLength={maxLength}
        onChange={e => onChange(e.target.value)}
        className="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2 text-xs bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-300 focus:border-transparent leading-relaxed"
      />
    </div>
  );
}
