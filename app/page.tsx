"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Sheet, SheetContent, SheetHeader } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectContent, SelectItem } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from "@/components/ui/alert-dialog";
import { PageHeader } from "@/components/page-header";
import {
  Search,
  X,
  Plus,
  Check,
  CheckCheck,
  CornerUpLeft,
  Ban,
  RotateCcw,
  ExternalLink,
  Upload,
  Sparkles,
  TriangleAlert,
  UserPlus,
  Send,
  Pause,
  Copy,
  CircleX,
  Eye,
  EyeOff,
  Star,
  Zap,
  ArrowRight,
  Download,
  Wand2,
} from "lucide-react";
import type { AppStage, OutreachState } from "@prisma/client";

// Auto-tailoring log shape (Job.tailorLog) — written by the resume pipeline when
// it produces a tailored PDF; null for manual uploads.
type TailorLog = {
  status?: "tailored" | "no_edits" | "failed" | "skipped";
  detail?: string;
  edits?: Array<{ find: string; replace: string; why: string }>;
  repairs?: number;
  compileProvider?: string;
} | null;

// ─── Types ────────────────────────────────────────────────────────────────────

type Job = {
  id: string; company: string; role: string; source: string;
  applyType: string; appStage: AppStage; outreachState: OutreachState;
  aiScore: number | null; aiReason: string | null; tailoredPitch: string | null;
  salaryAnnualBase: number | null; salaryCurrency: string | null;
  salaryBasis: string | null; salaryConfidence: string | null;
  salaryFlagReason: string | null; applyUrl: string; location: string | null;
  jdText: string; createdAt: string; postedAt: string | null; appStageNote: string | null;
  closedAt: string | null; closedReason: string | null;
  pinned: boolean;
  // Owner applied DIRECTLY with the alternate identity — independent of the
  // referral pipeline. Set/cleared via POST /api/jobs/applied.
  directAppliedAt: string | null;
  // Auto-tailoring provenance for the resume block (null = manual upload).
  tailorLog?: TailorLog;
  // Composite act-on-this-today score, computed by the list API (fit + pay +
  // trust + reach + freshness). priorityWhy is its one-line explanation.
  priority?: number; priorityWhy?: string;
  needsTailoring: boolean; tailoringSuggestions: string | null; tailoredResumeKey: string | null;
  // Pre-computed by the list API so the board never receives raw providerState JSON.
  outreachCounts?: { sent: number; connected: number; replied: number };
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
type Toast = { msg: string; tone: "info" | "warn" | "error"; undo?: () => void } | null;

const THREAD_PHASE_LABEL: Record<string, string> = {
  QUEUED:         "Queued — invite sends next tick",
  INVITE_PENDING: "Invite sent — awaiting acceptance",
  CONNECTED:      "Connected — DM sends next tick",
  MESSAGED:       "Messaged — awaiting reply",
  REPLIED:        "Replied",
};

// ─── Config ───────────────────────────────────────────────────────────────────

// Full stage list, kept for safety / type coverage. NEW is never its own board
// column (discover auto-approves, so NEW is permanently empty) — any stray NEW
// job folds into the Approved column via boardStageOf below.
const STAGES: AppStage[] = ["NEW","APPROVED","OUTREACH","REPLIED","APPLIED","INTERVIEWING","OFFER"];

// The columns actually rendered on the board. APPLIED is NOT a pipeline stage
// here — it's a marker column populated by Job.directAppliedAt (the owner's
// separate direct-application identity). A directly-applied job appears in the
// Applied column AND stays in its live outreach column; outreach is unaffected.
const BOARD_STAGES: AppStage[] = ["APPROVED","OUTREACH","REPLIED","INTERVIEWING","OFFER","APPLIED"];

// Which board column a job lands in — NEW folds into Approved; any legacy
// APPLIED-stage job folds into Replied so it never silently drops off the board.
const boardStageOf = (stage: AppStage): AppStage =>
  stage === "NEW" ? "APPROVED" : stage === "APPLIED" ? "REPLIED" : stage;

// Post-referral milestones the owner drives by hand once a target has replied.
const PIPELINE_STAGES: { stage: AppStage; action: string; label: string }[] = [
  { stage:"REPLIED",      action:"replied",      label:"Replied"      },
  { stage:"INTERVIEWING", action:"interviewing", label:"Interviewing" },
  { stage:"OFFER",        action:"offer",        label:"Offer"        },
];

const STAGE_META: Record<AppStage, { label: string; accent: string; headerBorder: string; lane: string; badge: string }> = {
  NEW:          { label:"New",          accent:"bg-zinc-400",    headerBorder:"border-l-zinc-300",    lane:"bg-transparent",   badge:"bg-muted text-muted-foreground" },
  APPROVED:     { label:"Approved",     accent:"bg-blue-500",    headerBorder:"border-l-blue-400",    lane:"bg-blue-50/40 dark:bg-blue-500/[0.06]",    badge:"bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300"       },
  OUTREACH:     { label:"Outreach",     accent:"bg-indigo-500",  headerBorder:"border-l-indigo-400",  lane:"bg-indigo-50/40 dark:bg-indigo-500/[0.06]",  badge:"bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"   },
  REPLIED:      { label:"Replied",      accent:"bg-emerald-500", headerBorder:"border-l-emerald-400", lane:"bg-emerald-50/40 dark:bg-emerald-500/[0.06]", badge:"bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" },
  APPLIED:      { label:"Applied",      accent:"bg-violet-500",  headerBorder:"border-l-violet-400",  lane:"bg-violet-50/40 dark:bg-violet-500/[0.06]",  badge:"bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"   },
  INTERVIEWING: { label:"Interviewing", accent:"bg-amber-500",   headerBorder:"border-l-amber-400",   lane:"bg-amber-50/40 dark:bg-amber-500/[0.06]",   badge:"bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"     },
  OFFER:        { label:"Offer",        accent:"bg-green-500",   headerBorder:"border-l-green-400",   lane:"bg-green-50/50 dark:bg-green-500/[0.06]",   badge:"bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300"     },
  SKIPPED:      { label:"Skipped",      accent:"bg-zinc-300",    headerBorder:"border-l-zinc-200",    lane:"bg-transparent",   badge:"bg-muted text-muted-foreground" },
};

// Next post-referral milestone for the board's one-click "advance" affordance.
const NEXT_STAGE: Partial<Record<AppStage, { action: string; label: string }>> = {
  REPLIED:      { action:"interviewing", label:"Mark interviewing" },
  INTERVIEWING: { action:"offer",        label:"Mark offer"        },
};

const SOURCE_LABEL: Record<string, string> = {
  LINKEDIN_JOB:"LinkedIn", LINKEDIN_POST:"LI Post", ADZUNA:"Adzuna",
  ATS_WATCHLIST:"Watchlist", REMOTIVE:"Remotive", REMOTEOK:"RemoteOK",
  JSEARCH:"JSearch", MANUAL:"Manual",
};

const OUTREACH_META: Record<string, { text: string; cls: string }> = {
  NONE:              { text:"",          cls:"" },
  INVITE_SENT:       { text:"Invite sent", cls:"text-blue-600 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-500/10 dark:border-blue-500/30" },
  CONNECTED:         { text:"Connected",   cls:"text-blue-600 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-500/10 dark:border-blue-500/30" },
  MESSAGED:          { text:"Messaged",    cls:"text-indigo-600 bg-indigo-50 border-indigo-200 dark:text-indigo-300 dark:bg-indigo-500/10 dark:border-indigo-500/30" },
  REPLIED:           { text:"Replied",     cls:"text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/10 dark:border-emerald-500/30" },
  NO_REPLY_ARCHIVED: { text:"No reply",    cls:"text-muted-foreground bg-muted border-border" },
};

// ─── Utils ────────────────────────────────────────────────────────────────────

const scoreClr = (n: number | null) =>
  n === null ? "bg-muted text-muted-foreground" :
  n >= 80 ? "bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300" :
  n >= 60 ? "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" : "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300";

const AVATAR_COLORS = [
  "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300","bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300","bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300","bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-300",
  "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300","bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-300",
];
const avatarClr = (name: string) => AVATAR_COLORS[name.charCodeAt(0) % 8];

const fmtSalary = (base: number | null, cur: string | null) =>
  !base ? null : new Intl.NumberFormat("en-IN", {
    style:"currency", currency: cur ?? "INR", maximumFractionDigits:0, notation:"compact",
  }).format(base);

// Mirrors src/sources/normalize.companyKey so the board's company grouping lands
// on the exact same boundary the engine uses to pool + dedup contacts.
const COMPANY_SUFFIX_RE = /\b(private limited|pvt\.? ?ltd\.?|p\.?ltd|limited|ltd\.?|llc|inc\.?|incorporated|co\.?|corp\.?|corporation|gmbh|s\.?a\.?|technologies|technology|solutions|systems|global services|services)\b/gi;
const groupKeyOf = (company: string) =>
  company.replace(COMPANY_SUFFIX_RE, " ").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);

// Relative posting date for the cards (falls back to discovery date via caller).
const fmtDate = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
};

// First meaningful segment of a role title, for compact role chips.
const shortRole = (role: string) => {
  const seg = (role.split(/[,(]/)[0] ?? role).trim();
  return seg.length > 26 ? seg.slice(0, 25) + "…" : seg;
};

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
  const [paused, setPaused]  = useState(false);
  const [sel, setSel]       = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [finding, setFinding] = useState(false);
  const [askNote, setAskNote] = useState(false);
  const [showSkipped, setShowSkipped]   = useState(false);
  const [skippedJobs, setSkippedJobs]   = useState<Job[]>([]);
  const [loadingSkipped, setLoadingSkipped] = useState(false);
  const [toast, setToast]   = useState<Toast>(null);
  // Destructive confirmations (blacklist) route through a proper AlertDialog
  // instead of window.confirm — the pending action is stored here.
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string; description: React.ReactNode; confirmLabel: string; onConfirm: () => void;
  } | null>(null);
  // "Applied directly?" flow — the job whose dialog is open, plus the alternate
  // resume info (fetched once) for the download link inside the dialog.
  const [appliedJob, setAppliedJob] = useState<Job | null>(null);
  const [altInfo, setAltInfo] = useState<{ altResumeKey: string | null; altIdentity: { email: string | null; phone: string | null } } | null>(null);
  const showToast = useCallback((msg: string, tone: "info" | "warn" | "error" = "info", undo?: () => void) => {
    setToast({ msg, tone, undo });
    setTimeout(() => setToast(null), 6000);
  }, []);
  const toggleSel = (id: string) => setSel(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const sendSelected = async (withNote: boolean) => {
    if (sel.size === 0) return;
    setSending(true);
    setAskNote(false);
    const jobIds = [...sel];
    // clearQueue: this bar is the manual fast-track — once we've sent, drop any
    // leftover queued invites for these jobs so the tick won't send more later.
    const res = await fetch("/api/outreach/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobIds, withNote, clearQueue: true }) }).then(r => r.json()).catch(() => null);
    setSending(false);
    setSel(new Set());
    const d = await fetch("/api/jobs?limit=200").then(r => r.json()).catch(() => null);
    if (d?.jobs) setJobs(d.jobs);
    if (res?.paused) showToast("Outreach is paused — turn it back on in Settings → Outreach.", "error");
    else if (res?.capped) showToast("Daily/weekly send cap hit. The rest go out automatically in the next window.", "warn");
    else if (res?.noThreads) showToast("Nothing to send for the selected jobs.", "info");
    else if (typeof res?.sent === "number") {
      const cleared = res.cleared ? ` · ${res.cleared} queued cleared` : "";
      showToast(`Sent ${res.sent} request${res.sent !== 1 ? "s" : ""}${cleared}.`, "info");
    }
  };
  // Find up to 10 LinkedIn people for each selected job and queue draft outreach.
  const findPeople = async () => {
    if (sel.size === 0) return;
    setFinding(true);
    const jobIds = [...sel];
    const res = await fetch("/api/outreach/find-people", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobIds, count: 10 }) }).then(r => r.json()).catch(() => null);
    setFinding(false);
    const d = await fetch("/api/jobs?limit=200").then(r => r.json()).catch(() => null);
    if (d?.jobs) setJobs(d.jobs);
    if (!res?.ok) showToast("Couldn't find people right now — try again.", "error");
    else if (res.drafted > 0) showToast(`Found ${res.drafted} ${res.drafted !== 1 ? "people" : "person"} across ${res.jobsTouched} job${res.jobsTouched !== 1 ? "s" : ""}. Review or hit "Send now".`, "info");
    else showToast("No new people found for the selected jobs.", "warn");
  };

  // Filters + sort (client-side over the loaded jobs)
  const [fQuery, setFQuery]   = useState("");
  const [fSource, setFSource] = useState("All");
  const [fApply, setFApply]   = useState("All");
  const [fScore, setFScore]   = useState("All");
  const [sort, setSort]       = useState<"Priority" | "Score" | "Salary" | "Date">("Priority");

  // Editable outreach drafts for the open job, keyed by threadId
  const [drafts, setDrafts] = useState<Record<string, DraftEdit>>({});

  useEffect(() => {
    fetch("/api/jobs?limit=200").then(r => r.json())
      .then(d => { setJobs(d.jobs ?? []); setLoading(false); })
      .catch(() => setLoading(false));
    fetch("/api/settings").then(r => r.json())
      .then(d => setPaused(!!d?.outreach?.globalPause))
      .catch(() => {});
    fetch("/api/resume/alt").then(r => r.json())
      .then(setAltInfo)
      .catch(() => {});
  }, []);

  const openJob = useCallback(async (job: Job) => {
    setSelected(job); setDetail(null);
    const full = await fetch(`/api/jobs/${job.id}`).then(r => r.json()) as Job;
    setDetail(full);
  }, []);

  const toggleSkipped = useCallback(async () => {
    if (showSkipped) { setShowSkipped(false); return; }
    setShowSkipped(true);
    setLoadingSkipped(true);
    const d = await fetch("/api/jobs?appStage=SKIPPED&limit=200").then(r => r.json()).catch(() => null);
    setSkippedJobs(d?.jobs ?? []);
    setLoadingSkipped(false);
  }, [showSkipped]);

  const act = useCallback(async (jobId: string, action: string) => {
    setActing(true);
    await fetch("/api/jobs/action", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ jobId, action }) });
    const updated = await fetch(`/api/jobs/${jobId}`).then(r => r.json()) as Job;
    setDetail(updated);
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, appStage: updated.appStage, outreachState: updated.outreachState } : j));
    setActing(false);
  }, []);

  // Same bidirectional-substring match the discover/blacklist API uses.
  const companyMatches = useCallback((co: string, term: string) => {
    const a = co.toLowerCase(), b = term.toLowerCase();
    return a.includes(b) || b.includes(a);
  }, []);

  // Quick card action — fire the stage change without opening the drawer.
  const quickAct = useCallback(async (e: React.MouseEvent, jobId: string, action: string) => {
    e.stopPropagation();
    setActing(true);
    await fetch("/api/jobs/action", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ jobId, action }) }).catch(() => {});
    const updated = await fetch(`/api/jobs/${jobId}`).then(r => r.json()).catch(() => null) as Job | null;
    if (updated) setJobs(prev => prev.map(j => j.id === jobId ? { ...j, appStage: updated.appStage, outreachState: updated.outreachState } : j));
    setActing(false);
  }, []);

  // Select/clear every job of a company group together (merged-card checkbox).
  const toggleSelMany = useCallback((ids: string[]) => setSel(prev => {
    const n = new Set(prev);
    const allSel = ids.every(id => n.has(id));
    ids.forEach(id => allSel ? n.delete(id) : n.add(id));
    return n;
  }), []);

  // Close or reopen ONE posting. This is NOT a blacklist and NOT a skip: the
  // company, its other roles, and the shared contact pool all stay. A closed
  // role just stops getting new invites; its in-flight outreach is re-pitched on
  // the open sibling automatically (server-side resolveActiveRole).
  const toggleRoleClosed = useCallback(async (e: React.MouseEvent, jobId: string, closed: boolean) => {
    e.stopPropagation();
    setActing(true);
    await fetch("/api/jobs/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId, closed }) }).catch(() => {});
    const stamp = closed ? new Date().toISOString() : null;
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, closedAt: stamp } : j));
    setDetail(d => (d && d.id === jobId) ? { ...d, closedAt: stamp } : d);
    setActing(false);
    showToast(closed ? "Role closed — outreach now goes out for the open role." : "Role reopened.", "info");
  }, [showToast]);

  // ⭐ pin — pinned jobs sort first and always make the Apply Today strip.
  const togglePinned = useCallback(async (e: React.MouseEvent, jobId: string, pinned: boolean) => {
    e.stopPropagation();
    // Optimistic — a star toggle should feel instant. Revert if the write
    // failed (fetch resolves on 4xx/5xx, so check ok too).
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, pinned } : j));
    setDetail(d => (d && d.id === jobId) ? { ...d, pinned } : d);
    const res = await fetch("/api/jobs/pin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId, pinned }) }).catch(() => null);
    if (!res?.ok) {
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, pinned: !pinned } : j));
      setDetail(d => (d && d.id === jobId) ? { ...d, pinned: !pinned } : d);
    }
  }, []);

  // ✓ Direct application — records that the owner applied DIRECTLY with the
  // alternate-identity resume, independent of the referral pipeline. Optimistic,
  // same pattern as togglePinned: revert if the write failed.
  const toggleDirectApplied = useCallback(async (jobId: string, applied: boolean) => {
    const stamp = applied ? new Date().toISOString() : null;
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, directAppliedAt: stamp } : j));
    setDetail(d => (d && d.id === jobId) ? { ...d, directAppliedAt: stamp } : d);
    const res = await fetch("/api/jobs/applied", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId, applied }) }).catch(() => null);
    if (!res?.ok) {
      const revert = applied ? null : new Date().toISOString();
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, directAppliedAt: revert } : j));
      setDetail(d => (d && d.id === jobId) ? { ...d, directAppliedAt: revert } : d);
      showToast("Couldn't update the direct-application status — try again.", "error");
    }
  }, [showToast]);

  // Blacklist the card's company: block future discovery + skip its open jobs now.
  const runBlacklistCompany = useCallback(async (company: string) => {
    // Capture current stages before wiping so we can undo.
    const restores = jobs
      .filter(j => companyMatches(j.company, company) && j.appStage !== "SKIPPED")
      .map(j => ({ id: j.id, stage: j.appStage as string }));
    setActing(true);
    const res = await fetch("/api/companies/blacklist", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ company }) }).then(r => r.json()).catch(() => null);
    setJobs(prev => prev.filter(j => !companyMatches(j.company, company)));
    setSelected(s => (s && companyMatches(s.company, company)) ? null : s);
    setActing(false);
    const n = res?.skipped ?? 0;
    const a = res?.archived ?? 0;
    const parts = [n ? `${n} job${n !== 1 ? "s" : ""} removed` : "", a ? `${a} outreach stopped` : ""].filter(Boolean);
    showToast(
      `Blacklisted ${company}${parts.length ? ` · ${parts.join(" · ")}` : ""}.`,
      "warn",
      async () => {
        await fetch("/api/companies/unblacklist", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ company, restores }) }).catch(() => {});
        const d = await fetch("/api/jobs?limit=200").then(r => r.json()).catch(() => null);
        if (d?.jobs) setJobs(d.jobs);
        showToast(`Unblacklisted ${company}.`, "info");
      },
    );
  }, [jobs, companyMatches, showToast]);

  // Blacklist the card's company: confirm first, then block + skip its jobs.
  const blacklistCompany = useCallback((e: React.MouseEvent, company: string) => {
    e.stopPropagation();
    setConfirmDialog({
      title: `Blacklist ${company}?`,
      description: "This removes its jobs from the board, stops any outreach, and blocks future ones. You can undo right after.",
      confirmLabel: "Blacklist company",
      onConfirm: () => runBlacklistCompany(company),
    });
  }, [runBlacklistCompany]);

  // Blacklist every distinct company in the current selection in one shot.
  const runBulkBlacklist = useCallback(async (companies: string[]) => {
    if (companies.length === 0) return;
    // Capture current stages for undo (per company).
    const restoresByCompany = companies.map(c => ({
      company: c,
      restores: jobs.filter(j => companyMatches(j.company, c) && j.appStage !== "SKIPPED").map(j => ({ id: j.id, stage: j.appStage as string })),
    }));
    setActing(true);
    const res = await fetch("/api/companies/blacklist", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ companies }) }).then(r => r.json()).catch(() => null);
    setJobs(prev => prev.filter(j => !companies.some(c => companyMatches(j.company, c))));
    setSel(new Set());
    setSelected(s => (s && companies.some(c => companyMatches(s.company, c))) ? null : s);
    setActing(false);
    const n = res?.skipped ?? 0;
    const a = res?.archived ?? 0;
    const parts = [
      `${companies.length} compan${companies.length !== 1 ? "ies" : "y"} blacklisted`,
      n ? `${n} job${n !== 1 ? "s" : ""} removed` : "",
      a ? `${a} outreach stopped` : "",
    ].filter(Boolean);
    showToast(
      `${parts.join(" · ")}.`,
      "warn",
      async () => {
        await Promise.all(restoresByCompany.map(({ company, restores }) =>
          fetch("/api/companies/unblacklist", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ company, restores }) }).catch(() => {}),
        ));
        const d = await fetch("/api/jobs?limit=200").then(r => r.json()).catch(() => null);
        if (d?.jobs) setJobs(d.jobs);
        showToast(`Unblacklisted ${companies.length} compan${companies.length !== 1 ? "ies" : "y"}.`, "info");
      },
    );
  }, [jobs, companyMatches, showToast]);

  const bulkBlacklist = useCallback(() => {
    const companies = Array.from(new Set(jobs.filter(j => sel.has(j.id)).map(j => j.company)));
    if (companies.length === 0) return;
    const label = companies.length === 1 ? companies[0] : `${companies.length} companies`;
    setConfirmDialog({
      title: `Blacklist ${label}?`,
      description: (
        <>
          {companies.join(", ")}
          <br />
          This removes their jobs from the board, stops any outreach, and blocks future ones.
        </>
      ),
      confirmLabel: `Blacklist ${companies.length === 1 ? "company" : "all"}`,
      onConfirm: () => runBulkBlacklist(companies),
    });
  }, [jobs, sel, runBulkBlacklist]);

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

  // Restore a skipped job back to New.
  const restoreJob = useCallback(async (e: React.MouseEvent, jobId: string) => {
    e.stopPropagation();
    setActing(true);
    await fetch("/api/jobs/action", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ jobId, action: "restore" }) }).catch(() => {});
    const updated = await fetch(`/api/jobs/${jobId}`).then(r => r.json()).catch(() => null) as Job | null;
    if (updated) {
      setSkippedJobs(prev => prev.filter(j => j.id !== jobId));
      setJobs(prev => [...prev, updated]);
    }
    setActing(false);
    showToast("Job restored to New.", "info");
  }, [showToast]);

  // Distinct sources present (for the Source filter options)
  const sourceOptions = useMemo(
    () => Array.from(new Set(jobs.map(j => j.source))),
    [jobs],
  );

  const visible = useMemo(() => {
    const q = fQuery.trim().toLowerCase();
    const v = jobs.filter(j => {
      if (q && !j.company.toLowerCase().includes(q) && !j.role.toLowerCase().includes(q)) return false;
      if (fSource !== "All" && j.source !== fSource) return false;
      if (fApply === "Referral" && j.applyType !== "REFERRAL_FIRST") return false;
      if (fApply === "Manual" && j.applyType !== "MANUAL_NOTIFY") return false;
      if (fScore === "80+" && (j.aiScore ?? 0) < 80) return false;
      if (fScore === "60+" && (j.aiScore ?? 0) < 60) return false;
      if (fScore === "<60" && (j.aiScore ?? 0) >= 60) return false;
      return true;
    });
    v.sort((a, b) => {
      // Pinned jobs always float to the top, whatever the sort.
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (sort === "Priority") return (b.priority ?? -1) - (a.priority ?? -1);
      if (sort === "Score")  return (b.aiScore ?? -1) - (a.aiScore ?? -1);
      if (sort === "Salary") return (b.salaryAnnualBase ?? -1) - (a.salaryAnnualBase ?? -1);
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return v;
  }, [jobs, fQuery, fSource, fApply, fScore, sort]);

  // "Apply Today" shortlist — the top 5 open jobs worth acting on right now:
  // pinned first, then by composite priority. Only stages where the owner still
  // has a move to make (NEW = approve, APPROVED/OUTREACH = push referrals).
  const applyToday = useMemo(() => {
    return jobs
      // Direct-applied jobs are done — the point of this strip is what's left to do.
      .filter(j => !j.closedAt && !j.directAppliedAt && ["NEW", "APPROVED", "OUTREACH"].includes(j.appStage))
      .sort((a, b) => (a.pinned !== b.pinned) ? (a.pinned ? -1 : 1) : (b.priority ?? -1) - (a.priority ?? -1))
      .slice(0, 5);
  }, [jobs]);

  // Buckets are keyed by board column; NEW folds into Approved (see boardStageOf).
  const byStage = BOARD_STAGES.reduce<Record<string, Job[]>>((a,s) => { a[s]=[]; return a; }, {});
  for (const j of visible) {
    if (j.appStage === "SKIPPED") continue;
    byStage[boardStageOf(j.appStage)]?.push(j);
    // Applied is a marker view, not a stage — a directly-applied job shows here
    // in ADDITION to its outreach column, so outreach keeps running as normal.
    if (j.directAppliedAt) byStage["APPLIED"].push(j);
  }

  const tw      = Date.now() - 7*24*60*60*1000;
  const replied = jobs.filter(j => j.outreachState === "REPLIED").length;
  const sent    = jobs.filter(j => j.outreachState !== "NONE").length;

  // Five tiles, no overlap: intake → approved → outreach volume → replies → rate.
  const stats = [
    { label:"Found this week", value: jobs.filter(j => j.appStage !== "SKIPPED" && new Date(j.createdAt).getTime() > tw).length, color:"text-foreground" },
    { label:"Approved",        value: jobs.filter(j => j.appStage === "APPROVED" || j.appStage === "NEW").length, color:"text-blue-600 dark:text-blue-400" },
    { label:"Outreach sent",   value: sent,                                                            color:"text-indigo-600 dark:text-indigo-400" },
    { label:"Replies",         value: replied,                                                         color:"text-emerald-600 dark:text-emerald-400" },
    { label:"Response rate",   value: sent > 0 ? `${Math.round(replied/sent*100)}%` : "—",            color:"text-foreground" },
  ];

  const job = detail ?? selected;

  // How many selected cards have outreach worth sending now (Approved =
  // queued invites; Outreach = in-flight threads to advance). Selection itself
  // works on any card, for "Find people" and bulk blacklisting.
  const selSendableCount = useMemo(
    () => jobs.filter(j => sel.has(j.id) && (j.appStage === "APPROVED" || j.appStage === "OUTREACH")).length,
    [jobs, sel],
  );

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden bg-background">

      <PageHeader title="Dashboard" subtitle="Your job-search pipeline, end to end">
        <button onClick={toggleSkipped}
          className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 h-8 rounded-lg border transition-colors ${showSkipped ? "bg-foreground text-background border-foreground" : "bg-card text-muted-foreground border-border hover:bg-accent hover:text-foreground"}`}>
          {showSkipped ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          {showSkipped ? "Hide skipped" : "Skipped"}
        </button>
        <a href="/add"
          className="inline-flex items-center gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold px-3 h-8 rounded-lg shadow-sm transition-colors">
          <Plus className="size-3.5" /> Add job
        </a>
      </PageHeader>

      {/* ── Stats + Controls ──────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-6 pt-5 pb-4 space-y-4">

        {/* Stat cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {stats.map(({ label, value, color }) => (
            <div key={label} className="bg-card rounded-xl border border-border shadow-sm px-4 py-3">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1">{label}</p>
              <p className={`text-2xl font-semibold tabular-nums ${loading ? "text-muted animate-pulse" : color}`}>
                {loading ? "0" : value}
              </p>
            </div>
          ))}
        </div>

        {/* Pause banner */}
        {paused && (
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700 dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-300">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Pause className="size-4 shrink-0" />
              Outreach is paused — no invites or DMs will be sent until you turn it back on.
            </div>
            <a href="/settings" className="text-xs font-semibold underline underline-offset-2 whitespace-nowrap hover:text-red-900 dark:hover:text-red-100">
              Settings → Outreach
            </a>
          </div>
        )}

        {/* Filter bar */}
        <div className="flex items-center gap-2">
          <div className="relative w-56">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={fQuery}
              onChange={e => setFQuery(e.target.value)}
              placeholder="Search company or role…"
              className="h-8 pl-8 pr-7 text-xs bg-card border-border shadow-sm rounded-lg"
            />
            {fQuery && (
              <button onClick={() => setFQuery("")} aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <Select value={fSource} onValueChange={(v: string | null) => setFSource(v ?? "All")}>
            <SelectTrigger className="h-8 text-xs text-muted-foreground shadow-sm">
              {`Source: ${fSource === "All" ? "All" : (SOURCE_LABEL[fSource] ?? fSource)}`}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">All sources</SelectItem>
              {sourceOptions.map(src => <SelectItem key={src} value={src}>{SOURCE_LABEL[src] ?? src}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={fApply} onValueChange={(v: string | null) => setFApply(v ?? "All")}>
            <SelectTrigger className="h-8 text-xs text-muted-foreground shadow-sm">
              {`Apply: ${fApply === "All" ? "All" : fApply === "Referral" ? "Referral first" : "Manual apply"}`}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">Apply type: All</SelectItem>
              <SelectItem value="Referral">Referral first</SelectItem>
              <SelectItem value="Manual">Manual apply</SelectItem>
            </SelectContent>
          </Select>
          <Select value={fScore} onValueChange={(v: string | null) => setFScore(v ?? "All")}>
            <SelectTrigger className="h-8 text-xs text-muted-foreground shadow-sm">
              {`Score: ${fScore}`}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">Score: All</SelectItem>
              <SelectItem value="80+">Score: 80+</SelectItem>
              <SelectItem value="60+">Score: 60+</SelectItem>
              <SelectItem value="<60">{"Score: <60"}</SelectItem>
            </SelectContent>
          </Select>
          {(fQuery !== "" || fSource !== "All" || fApply !== "All" || fScore !== "All") && (
            <button onClick={() => { setFQuery(""); setFSource("All"); setFApply("All"); setFScore("All"); }}
              className="text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 transition-colors">Clear</button>
          )}
          <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
            <span className="mr-1 font-medium">Sort</span>
            {(["Priority","Score","Salary","Date"] as const).map(sortKey => (
              <button key={sortKey} onClick={() => setSort(sortKey)}
                className={`px-2.5 py-1.5 rounded-lg transition-all ${sort === sortKey ? "bg-card text-foreground shadow-sm font-medium ring-1 ring-border" : "hover:bg-card hover:text-foreground hover:shadow-sm"}`}>
                {sortKey}
              </button>
            ))}
          </div>
        </div>

        {/* ── Apply Today — top 5 by priority (pinned always first) ────── */}
        {!loading && applyToday.length > 0 && (
          <div className="bg-card rounded-xl border border-border shadow-sm px-4 py-3">
            <div className="flex items-center gap-2 mb-2.5">
              <p className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
                <Zap className="size-3 text-primary" /> Apply Today
              </p>
              <p className="text-[10px] text-muted-foreground/70">fit · pay · reach · freshness</p>
            </div>
            <div className="flex gap-2.5 overflow-x-auto pb-0.5 scrollbar-slim">
              {applyToday.map((j, i) => (
                <button key={j.id} onClick={() => openJob(j)}
                  title={j.priorityWhy}
                  className="flex items-center gap-2.5 min-w-[210px] max-w-[260px] text-left bg-muted/50 hover:bg-card border border-border hover:border-foreground/20 hover:shadow-sm rounded-lg px-3 py-2 transition-all">
                  <span className="text-sm font-bold text-muted-foreground/50 tabular-nums shrink-0">{i + 1}</span>
                  <Avatar className={`h-7 w-7 rounded-lg shrink-0 ${avatarClr(j.company)}`}>
                    <AvatarFallback className={`rounded-lg text-[11px] font-bold ${avatarClr(j.company)}`}>
                      {j.company.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1 text-xs font-semibold text-foreground truncate leading-tight">
                      {j.pinned && <Star className="size-3 shrink-0 text-primary fill-primary" />}
                      <span className="truncate">{j.company}</span>
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate leading-tight">{shortRole(j.role)}</p>
                  </div>
                  <span className={`shrink-0 text-[11px] font-bold px-1.5 py-0.5 rounded-md ${scoreClr(j.priority ?? null)}`}>
                    {j.priority ?? "—"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Kanban ────────────────────────────────────────────────────── */}
      {/* min-h-0 lets this flex child shrink to the viewport so the columns
          inside can own the vertical scroll (without it the board grows past
          the screen and everything clips — the "nothing scrolls" bug). */}
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-6 pb-6 scrollbar-slim">
        {/* Board container */}
        <div className="flex h-full w-full rounded-2xl border border-border shadow-sm bg-card overflow-hidden">
          {/* Post-referral pipeline columns only appear once something is in
              them — permanently-empty columns are dead board space. */}
          {BOARD_STAGES.filter(s =>
            !["INTERVIEWING", "OFFER", "APPLIED"].includes(s) || byStage[s].length > 0
          ).map((stage, i, cols) => {
            const meta  = STAGE_META[stage];
            const cards = byStage[stage];
            const isLast = i === cols.length - 1;
            return (
              <div key={stage} className={`flex-1 min-w-[220px] flex flex-col ${!isLast ? "border-r border-border" : ""}`}>

                {/* Column header */}
                <div className={`flex-shrink-0 flex items-center gap-2.5 px-5 py-4 border-b border-border border-l-[3px] ${meta.headerBorder} bg-card`}>
                  <div className={`w-2 h-2 rounded-full shrink-0 ${meta.accent}`} />
                  <span className="text-sm font-semibold text-foreground">{meta.label}</span>
                  <span className="ml-auto text-xs font-semibold text-muted-foreground tabular-nums bg-muted rounded-full px-2 py-0.5 min-w-[24px] text-center">
                    {cards.length}
                  </span>
                  {cards.length > 0 && (
                    <button
                      onClick={() => setSel(prev => {
                        const ids = cards.map(c => c.id);
                        const allSel = ids.every(id => prev.has(id));
                        const n = new Set(prev);
                        ids.forEach(id => allSel ? n.delete(id) : n.add(id));
                        return n;
                      })}
                      className="text-[11px] text-muted-foreground hover:text-foreground font-medium ml-1"
                    >
                      {cards.every(c => sel.has(c.id)) ? "Clear" : "Select all"}
                    </button>
                  )}
                </div>

                {/* Cards — min-h-0 so this pane, not the column, takes the scroll */}
                <div className={`min-h-0 flex-1 overflow-y-auto p-4 space-y-3 scrollbar-slim ${meta.lane}`}>
                  {loading && (
                    <>
                      <div className="bg-muted rounded-xl h-24 animate-pulse" />
                      <div className="bg-muted rounded-xl h-20 animate-pulse opacity-60" />
                    </>
                  )}
                  {!loading && cards.length === 0 && (
                    <p className="px-1 py-2 text-xs text-muted-foreground/60">No jobs</p>
                  )}
                  {buildCompanyGroups(cards).map(group => (
                    <CompanyCard
                      key={group.key}
                      group={group}
                      selected={sel}
                      acting={acting}
                      openJob={openJob}
                      toggleSel={toggleSel}
                      toggleSelMany={toggleSelMany}
                      quickAct={quickAct}
                      blacklistCompany={blacklistCompany}
                      toggleRoleClosed={toggleRoleClosed}
                      togglePinned={togglePinned}
                      openApplied={setAppliedJob}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Skipped panel ─────────────────────────────────────────────── */}
      {showSkipped && (
        <div className="flex-shrink-0 px-6 pb-6">
          <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
            <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-border border-l-[3px] border-l-zinc-300 dark:border-l-zinc-600">
              <div className="w-2 h-2 rounded-full bg-zinc-300 dark:bg-zinc-600" />
              <span className="text-sm font-semibold text-muted-foreground">Skipped</span>
              <span className="text-xs font-semibold text-muted-foreground bg-muted rounded-full px-2 py-0.5">{loadingSkipped ? "…" : skippedJobs.length}</span>
            </div>
            <div className="p-4">
              {loadingSkipped && (
                <div className="grid grid-cols-4 gap-3">
                  <div className="bg-muted rounded-xl h-20 animate-pulse" />
                  <div className="bg-muted rounded-xl h-20 animate-pulse opacity-60" />
                </div>
              )}
              {!loadingSkipped && skippedJobs.length === 0 && (
                <p className="text-sm text-muted-foreground py-2">No skipped jobs.</p>
              )}
              {!loadingSkipped && skippedJobs.length > 0 && (
                <div className="grid grid-cols-4 gap-3 max-h-64 overflow-y-auto">
                  {skippedJobs.map(sj => (
                    <div key={sj.id} className="relative group bg-muted/50 border border-border rounded-xl p-3 flex flex-col gap-1">
                      <div className="flex items-start gap-2">
                        <Avatar className={`h-7 w-7 rounded-lg shrink-0 ${avatarClr(sj.company)}`}>
                          <AvatarFallback className={`rounded-lg text-[11px] font-bold ${avatarClr(sj.company)}`}>
                            {sj.company.charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold text-foreground truncate">{sj.company}</p>
                          <p className="text-[11px] text-muted-foreground truncate">{sj.role}</p>
                        </div>
                        {sj.aiScore !== null && (
                          <span className={`text-[10px] font-bold px-1 py-0.5 rounded shrink-0 ${scoreClr(sj.aiScore)}`}>{sj.aiScore}</span>
                        )}
                      </div>
                      {sj.appStageNote && (
                        <p className="text-[10px] text-muted-foreground truncate">{sj.appStageNote}</p>
                      )}
                      <button
                        onClick={(e) => restoreJob(e, sj.id)}
                        disabled={acting}
                        className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-card border border-border rounded-lg px-2 py-1 transition-colors self-start">
                        <RotateCcw className="size-3" /> Restore
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Toast ─────────────────────────────────────────────────────── */}
      {toast && (
        <div className={`fixed top-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg border animate-in fade-in slide-in-from-top-2 ${
          toast.tone === "error" ? "bg-red-50 border-red-200 text-red-700 dark:bg-red-500/15 dark:border-red-500/30 dark:text-red-200"
          : toast.tone === "warn" ? "bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-500/15 dark:border-amber-500/30 dark:text-amber-200"
          : "bg-zinc-900 border-zinc-800 text-white dark:bg-zinc-800 dark:border-zinc-700"
        }`}>
          {toast.tone === "error" ? <CircleX className="size-4 shrink-0" /> : toast.tone === "warn" ? <TriangleAlert className="size-4 shrink-0" /> : <Check className="size-4 shrink-0" />}
          {toast.msg}
          {toast.undo && (
            <button onClick={() => { toast.undo!(); setToast(null); }}
              className="ml-2 font-semibold underline underline-offset-2 opacity-80 hover:opacity-100">
              Undo
            </button>
          )}
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="ml-1 opacity-50 hover:opacity-100"><X className="size-3.5" /></button>
        </div>
      )}

      {/* ── Bulk action bar ───────────────────────────────────────────── */}
      {sel.size > 0 && !askNote && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-zinc-900 text-white rounded-full shadow-xl pl-5 pr-2 py-2 dark:bg-zinc-800 dark:ring-1 dark:ring-white/10">
          <span className="text-sm font-medium">{sel.size} selected</span>
          <button onClick={() => setSel(new Set())} className="text-xs text-zinc-300 hover:text-white mr-1">Clear</button>
          <button onClick={findPeople} disabled={finding || sending || acting}
            className="inline-flex items-center gap-1.5 bg-zinc-700 text-white text-sm font-semibold rounded-full px-4 py-1.5 hover:bg-zinc-600 disabled:opacity-60">
            <UserPlus className="size-3.5" /> {finding ? "Finding…" : "Find people"}
          </button>
          <button onClick={bulkBlacklist} disabled={acting || sending || finding}
            className="inline-flex items-center gap-1.5 bg-red-500 text-white text-sm font-semibold rounded-full px-4 py-1.5 hover:bg-red-600 disabled:opacity-60">
            <Ban className="size-3.5" /> Blacklist
          </button>
          {selSendableCount > 0 && (
            <button onClick={() => setAskNote(true)} disabled={sending || finding}
              className="bg-primary text-primary-foreground text-sm font-semibold rounded-full px-4 py-1.5 hover:bg-primary/90 disabled:opacity-60 flex items-center gap-1.5">
              <Send className="size-3.5" /> {sending ? "Sending…" : "Send now"}
            </button>
          )}
        </div>
      )}

      {/* Connection-note choice for the manual bulk send */}
      {sel.size > 0 && askNote && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-zinc-900 text-white rounded-2xl shadow-xl px-4 py-3 dark:bg-zinc-800 dark:ring-1 dark:ring-white/10">
          <span className="text-sm font-medium mr-1">Add a connection note to {selSendableCount} invite{selSendableCount !== 1 ? "s" : ""}?</span>
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
        <SheetContent className="!w-[500px] !max-w-[500px] p-0 flex flex-col bg-card" showCloseButton>

          <SheetHeader className="px-6 pt-6 pb-5 border-b border-border flex-shrink-0">
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
                    <p className="font-bold text-base text-foreground leading-tight">{job?.company}</p>
                    <p className="text-sm text-muted-foreground mt-0.5">{job?.role}</p>
                    {job?.location && <p className="text-xs text-muted-foreground/70 mt-0.5">{job.location}</p>}
                  </div>
                  <div className="shrink-0 flex items-start gap-1.5">
                    {job && (
                      <button title={job.pinned ? "Unpin" : "Pin — always show in Apply Today"}
                        onClick={(e) => togglePinned(e, job.id, !job.pinned)}
                        className={`w-8 h-8 rounded-xl border flex items-center justify-center transition-colors ${job.pinned ? "border-primary/40 text-primary bg-primary/10" : "border-border text-muted-foreground/60 hover:text-primary hover:border-primary/40 hover:bg-primary/10"}`}>
                        <Star className={`size-4 ${job.pinned ? "fill-primary" : ""}`} />
                      </button>
                    )}
                    {job && (
                      <button title={job.directAppliedAt ? "Applied directly — click to undo" : "Applied directly?"}
                        onClick={() => setAppliedJob(job)}
                        className={`w-8 h-8 rounded-xl border flex items-center justify-center transition-colors ${job.directAppliedAt ? "border-emerald-300 text-emerald-600 bg-emerald-50 dark:border-emerald-500/40 dark:text-emerald-300 dark:bg-emerald-500/15" : "border-border text-muted-foreground/60 hover:text-emerald-600 hover:border-emerald-300 hover:bg-emerald-50 dark:hover:text-emerald-300 dark:hover:border-emerald-500/40 dark:hover:bg-emerald-500/10"}`}>
                        <CheckCheck className="size-4" />
                      </button>
                    )}
                    {job?.aiScore !== null && job?.aiScore !== undefined && (
                      <div className={`text-center px-3 py-1.5 rounded-xl ${scoreClr(job.aiScore)}`}>
                        <p className="text-xl font-bold leading-none">{job.aiScore}</p>
                        <p className="text-[9px] font-semibold uppercase tracking-widest mt-0.5 opacity-50">score</p>
                      </div>
                    )}
                  </div>
                </div>
                {job && (
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    <span className={`text-[10px] rounded-md px-2 py-1 font-medium ${STAGE_META[job.appStage].badge}`}>
                      {STAGE_META[job.appStage].label}
                    </span>
                    <span className="text-[10px] bg-muted text-muted-foreground rounded-md px-2 py-1">
                      {SOURCE_LABEL[job.source] ?? job.source}
                    </span>
                    {job.applyType === "REFERRAL_FIRST" && (
                      <span className="text-[10px] bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300 rounded-md px-2 py-1 font-medium">Referral First</span>
                    )}
                    {job.closedAt && (
                      <span className="text-[10px] bg-muted text-muted-foreground rounded-md px-2 py-1 font-medium">Role closed</span>
                    )}
                    {job.directAppliedAt && (
                      <span className="inline-flex items-center gap-1 text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300 rounded-md px-2 py-1 font-medium"><CheckCheck className="size-3" /> Applied</span>
                    )}
                    {job.outreachState !== "NONE" && OUTREACH_META[job.outreachState].text && (
                      <span className={`text-[10px] border rounded-md px-2 py-1 font-medium ${OUTREACH_META[job.outreachState].cls}`}>
                        {OUTREACH_META[job.outreachState].text}
                      </span>
                    )}
                    {(() => { const d = fmtDate(job.postedAt ?? job.createdAt); return d ? (
                      <span className="text-[10px] text-muted-foreground px-1 py-1">Posted {d}</span>
                    ) : null; })()}
                  </div>
                )}
              </div>
            </div>
          </SheetHeader>

          {job && (
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

              {job.aiReason && (
                <div>
                  <p className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2"><Sparkles className="size-3 text-primary" /> AI analysis</p>
                  <p className="text-sm text-foreground/90 leading-relaxed">{job.aiReason}</p>
                </div>
              )}

              {job.tailoredPitch && (
                <div className="bg-muted/50 border border-border rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2.5">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Generated pitch</p>
                    <button
                      onClick={() => { navigator.clipboard.writeText(job.tailoredPitch!); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                      className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
                      {copied ? <><Check className="size-3" /> Copied</> : <><Copy className="size-3" /> Copy</>}
                    </button>
                  </div>
                  <p className="text-sm text-foreground/90 leading-relaxed italic whitespace-pre-line">
                    &ldquo;{job.tailoredPitch}&rdquo;
                  </p>
                </div>
              )}

              <Separator className="bg-border" />

              {/* Salary + Apply */}
              <div className="flex items-center justify-between">
                <div>
                  {job.salaryAnnualBase ? (
                    <>
                      <p className={`text-xl font-bold ${job.salaryBasis === "ESTIMATED" ? "text-amber-700 dark:text-amber-400" : "text-foreground"}`}>
                        {fmtSalary(job.salaryAnnualBase, job.salaryCurrency)}/yr
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {job.salaryBasis === "STATED" ? "Stated salary" : `Estimated · ${job.salaryConfidence?.toLowerCase() ?? "low"} confidence`}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">Salary unknown</p>
                  )}
                </div>
                {job.applyUrl && (
                  <a href={job.applyUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold px-4 py-2 rounded-xl shadow-sm transition-colors">
                    <ExternalLink className="size-3.5" /> Apply
                  </a>
                )}
              </div>

              <Separator className="bg-border" />

              {/* Resume gate */}
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2">Resume</p>
                {!job.needsTailoring ? (
                  <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/10 dark:border-emerald-500/30 rounded-xl px-3 py-2.5">
                    <Check className="size-4 shrink-0" /> Base resume is a good fit — no tailoring needed.
                  </div>
                ) : job.tailoredResumeKey ? (
                  job.tailorLog?.status === "tailored" ? (
                    // Auto-tailored by the pipeline — surface WHAT changed, with a
                    // link to the full before → after diff on the job page.
                    (() => {
                      const edits = job.tailorLog?.edits ?? [];
                      return (
                        <div className="bg-emerald-50 border border-emerald-200 dark:bg-emerald-500/10 dark:border-emerald-500/30 rounded-xl p-3.5 space-y-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                              <Wand2 className="size-4 shrink-0" /> Auto-tailored · {edits.length} edit{edits.length !== 1 ? "s" : ""}
                            </span>
                            <a href={`/api/resume/download?key=${encodeURIComponent(job.tailoredResumeKey)}`} target="_blank" rel="noopener noreferrer"
                              className="text-xs font-medium text-emerald-700 dark:text-emerald-300 underline underline-offset-2 shrink-0">View PDF</a>
                          </div>
                          {edits.length > 0 && (
                            <ul className="space-y-1">
                              {edits.map((e, i) => (
                                <li key={i} className="flex items-start gap-1.5 text-xs text-emerald-800/90 dark:text-emerald-200/80">
                                  <span className="mt-1 size-1 rounded-full bg-emerald-500 shrink-0" />
                                  <span className="leading-relaxed truncate">{e.why || "(no rationale given)"}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                          <a href={`/jobs/${job.id}`}
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-indigo-800 dark:hover:text-indigo-300 underline underline-offset-2">
                            See before → after <ArrowRight className="size-3" />
                          </a>
                        </div>
                      );
                    })()
                  ) : (
                    // No tailor log → the owner uploaded a tailored PDF by hand.
                    <div className="flex items-center justify-between gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/10 dark:border-emerald-500/30 rounded-xl px-3 py-2.5">
                      <span className="flex items-center gap-2"><Check className="size-4 shrink-0" /> Uploaded manually</span>
                      <a href={`/api/resume/download?key=${encodeURIComponent(job.tailoredResumeKey)}`} target="_blank" rel="noopener noreferrer"
                        className="text-xs font-medium underline">View</a>
                    </div>
                  )
                ) : (
                  <div className="bg-amber-50 border border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/30 rounded-xl p-3.5 space-y-2.5">
                    <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-800 dark:text-amber-300"><TriangleAlert className="size-4 shrink-0" /> Tailoring recommended before outreach</p>
                    {job.tailoringSuggestions && (
                      <p className="text-xs text-amber-700 dark:text-amber-400/90 leading-relaxed whitespace-pre-line">{job.tailoringSuggestions}</p>
                    )}
                    <button
                      onClick={() => resumeFileRef.current?.click()}
                      disabled={uploadingResume}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-lg px-3 py-2 transition-colors">
                      <Upload className="size-3.5" /> {uploadingResume ? "Uploading…" : "Upload tailored resume (PDF)"}
                    </button>
                    <input ref={resumeFileRef} type="file" accept="application/pdf" className="hidden"
                      onChange={e => { const f = e.target.files?.[0]; if (f) uploadTailored(job.id, f); }} />
                  </div>
                )}
              </div>

              <Separator className="bg-border" />

              {/* Direct application — the alternate-identity apply, independent of
                  the referral pipeline. */}
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2">Direct application</p>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/50 px-3 py-2.5">
                  <div className="min-w-0">
                    {job.directAppliedAt ? (
                      <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                        <CheckCheck className="size-4 shrink-0" /> Applied directly on {new Date(job.directAppliedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">Not applied directly yet.</p>
                    )}
                    <p className="text-[11px] text-muted-foreground/70 mt-0.5">Uses the alternate-identity resume — separate from referral outreach.</p>
                  </div>
                  <Button onClick={() => setAppliedJob(job)} disabled={acting}
                    variant={job.directAppliedAt ? "outline" : "default"} size="sm"
                    className={`text-xs h-9 shrink-0 ${job.directAppliedAt ? "" : "bg-emerald-600 hover:bg-emerald-700 text-white"}`}>
                    {job.directAppliedAt ? "Undo" : <><CheckCheck className="size-3.5" /> Mark applied</>}
                  </Button>
                </div>
              </div>

              <Separator className="bg-border" />

              {job.appStage === "NEW" && (
                <div className="space-y-2">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Actions</p>
                  <div className="flex gap-2">
                    <Button onClick={() => act(job.id,"approve")} disabled={acting} size="sm"
                      className="flex-1 text-xs h-9">
                      <Check className="size-3.5" /> Approve &amp; queue outreach
                    </Button>
                    <Button onClick={() => act(job.id,"skip")} disabled={acting} variant="outline" size="sm" className="text-xs h-9">
                      Skip
                    </Button>
                  </div>
                </div>
              )}

              {["APPROVED","OUTREACH","REPLIED","APPLIED","INTERVIEWING","OFFER"].includes(job.appStage) && (
                <div className="space-y-2">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Pipeline stage</p>
                  {/* Segmented control — advance the job through the post-referral
                      milestones. Active stage is filled indigo; the rest are the
                      next moves the owner can make. */}
                  <div className="inline-flex w-full rounded-lg border border-border bg-muted/50 p-0.5">
                    {PIPELINE_STAGES.map(({ stage, action, label }) => {
                      const active = job.appStage === stage;
                      return (
                        <button key={stage} onClick={() => act(job.id, action)} disabled={acting || active}
                          className={`flex-1 text-[11px] font-medium h-8 rounded-md transition-colors ${active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-card disabled:opacity-50"}`}>
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  <Button onClick={() => act(job.id, "skipped")} disabled={acting}
                    variant="outline" size="sm" className="text-xs h-9 text-red-600 dark:text-red-400">Skip / stop</Button>
                </div>
              )}

              {job.appStage !== "SKIPPED" && (
                <div className="space-y-2">
                  <Button onClick={(e) => toggleRoleClosed(e, job.id, !job.closedAt)} disabled={acting}
                    variant="outline" size="sm"
                    className="text-xs h-9 w-full justify-start text-muted-foreground hover:bg-accent">
                    {job.closedAt
                      ? <><RotateCcw className="size-3.5" /> Reopen this role</>
                      : <><Ban className="size-3.5" /> Close this role (keep contacts, redirect outreach)</>}
                  </Button>
                  <Button onClick={(e) => blacklistCompany(e, job.company)} disabled={acting}
                    variant="outline" size="sm"
                    className="text-xs h-9 w-full justify-start text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:border-red-500/30 dark:hover:bg-red-500/10 dark:hover:text-red-300">
                    <Ban className="size-3.5" /> Blacklist {job.company} &amp; stop outreach
                  </Button>
                </div>
              )}

              {(job.outreaches?.length ?? 0) > 0 && (
                <>
                  <Separator className="bg-border" />
                  <div>
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-3">Outreach</p>
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
                          <div key={o.id} className="bg-muted/50 rounded-xl border border-border overflow-hidden">
                            <div className="flex gap-3 items-start p-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-xs font-semibold text-foreground truncate">
                                    {o.contact.name}
                                    {o.contact.title && <span className="font-normal text-muted-foreground"> · {o.contact.title}</span>}
                                  </p>
                                  <a href={o.contact.linkedinUrl} target="_blank" rel="noopener noreferrer"
                                    className="inline-flex items-center gap-0.5 text-[10px] font-medium text-primary hover:underline shrink-0">LinkedIn <ExternalLink className="size-2.5" /></a>
                                </div>
                                <p className="text-[10px] text-muted-foreground mt-0.5">
                                  <span className="capitalize">{o.role.toLowerCase()}</span>
                                  {label && <span className="text-foreground/70"> · {label}</span>}
                                </p>
                              </div>
                            </div>

                            {isDraft && t && (
                              <div className="border-t border-border bg-card p-3 space-y-2.5">
                                <p className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">Review &amp; edit — nothing sends until you confirm.</p>
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
                                    className="flex-1 text-xs h-9">
                                    <Send className="size-3.5" /> Confirm &amp; send
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
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  Approved — no LinkedIn targets were found for this role yet. You can still apply directly via the link above.
                </div>
              )}

              <Separator className="bg-border" />
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-3">Job description</p>
                <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed max-h-72 overflow-y-auto bg-muted/50 rounded-xl p-4 border border-border">
                  {job.jdText}
                </pre>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* ── Destructive confirmation ──────────────────────────────────── */}
      <AlertDialog open={!!confirmDialog} onOpenChange={(open: boolean) => { if (!open) setConfirmDialog(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmDialog?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmDialog?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDialog(null)}>Cancel</Button>
            <Button variant="destructive" size="sm"
              onClick={() => { confirmDialog?.onConfirm(); setConfirmDialog(null); }}>
              <Ban className="size-3.5" /> {confirmDialog?.confirmLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Applied-directly confirmation ─────────────────────────────── */}
      <AlertDialog open={!!appliedJob} onOpenChange={(open: boolean) => { if (!open) setAppliedJob(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{appliedJob?.directAppliedAt ? "Undo direct application?" : "Applied directly?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {appliedJob?.directAppliedAt
                ? "This clears the record that you applied directly to this job with your alternate-identity resume."
                : "This records that you applied directly to this job using your alternate-identity resume (same content, alternate email + phone) — independent of the referral outreach."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {!appliedJob?.directAppliedAt && altInfo?.altResumeKey && (
            <a href={`/api/resume/download?key=${encodeURIComponent(altInfo.altResumeKey)}`} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-indigo-800 dark:hover:text-indigo-300 underline underline-offset-2">
              <Download className="size-3.5" /> Download alt resume
            </a>
          )}
          <AlertDialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAppliedJob(null)}>Cancel</Button>
            <Button size="sm"
              className={appliedJob?.directAppliedAt ? "" : "bg-emerald-600 hover:bg-emerald-700 text-white"}
              variant={appliedJob?.directAppliedAt ? "destructive" : "default"}
              onClick={() => { if (appliedJob) toggleDirectApplied(appliedJob.id, !appliedJob.directAppliedAt); setAppliedJob(null); }}>
              {appliedJob?.directAppliedAt ? "Undo" : <><CheckCheck className="size-3.5" /> Mark applied</>}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function DraftField({ label, value, rows, maxLength, onChange }: {
  label: string; value: string; rows: number; maxLength?: number; onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">{label}</label>
      <textarea
        value={value}
        rows={rows}
        maxLength={maxLength}
        onChange={e => onChange(e.target.value)}
        className="mt-1 w-full border border-border rounded-lg px-3 py-2 text-xs bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring leading-relaxed"
      />
    </div>
  );
}

// ─── Company grouping ───────────────────────────────────────────────────────
// Same-company postings (within a stage column) collapse into ONE card. The
// shared candidate pool, dedup, and active-role routing all happen server-side;
// this is the visual half of the merge.

type CompanyGroup = { key: string; company: string; jobs: Job[] };

function buildCompanyGroups(cards: Job[]): CompanyGroup[] {
  const map = new Map<string, CompanyGroup>();
  for (const job of cards) {
    const key = groupKeyOf(job.company) || job.company.toLowerCase();
    const g = map.get(key);
    if (g) g.jobs.push(job);
    else map.set(key, { key, company: job.company, jobs: [job] });
  }
  // cards are already sorted; first-seen order preserves that sort across groups.
  return [...map.values()];
}

function CompanyCard({
  group, selected, acting, openJob, toggleSel, toggleSelMany, quickAct, blacklistCompany, toggleRoleClosed, togglePinned, openApplied,
}: {
  group: CompanyGroup;
  selected: Set<string>;
  acting: boolean;
  openJob: (job: Job) => void;
  toggleSel: (id: string) => void;
  toggleSelMany: (ids: string[]) => void;
  quickAct: (e: React.MouseEvent, jobId: string, action: string) => void;
  blacklistCompany: (e: React.MouseEvent, company: string) => void;
  toggleRoleClosed: (e: React.MouseEvent, jobId: string, closed: boolean) => void;
  togglePinned: (e: React.MouseEvent, jobId: string, pinned: boolean) => void;
  openApplied: (job: Job) => void;
}) {
  const jobs = group.jobs;
  const multi = jobs.length > 1;
  const ids = jobs.map(j => j.id);
  const allSel = ids.every(id => selected.has(id));
  const someSel = !allSel && ids.some(id => selected.has(id));

  // Representative role for the header + hover actions: prefer an OPEN role, then
  // the highest score — so clicking the card lands on the role you'd actually pitch.
  const primary = [...jobs].sort((a, b) => {
    const ao = a.closedAt ? 1 : 0, bo = b.closedAt ? 1 : 0;
    return ao - bo || (b.aiScore ?? -1) - (a.aiScore ?? -1);
  })[0];

  const maxScore = jobs.reduce<number | null>(
    (m, j) => j.aiScore == null ? m : Math.max(m ?? -1, j.aiScore), null);

  const sals = jobs.map(j => j.salaryAnnualBase).filter((n): n is number => n != null);
  const cur = jobs.find(j => j.salaryCurrency)?.salaryCurrency ?? null;
  const salText = sals.length === 0 ? null
    : Math.min(...sals) === Math.max(...sals) ? `${fmtSalary(Math.min(...sals), cur)}/yr`
    : `${fmtSalary(Math.min(...sals), cur)}–${fmtSalary(Math.max(...sals), cur)}/yr`;

  const dateText = fmtDate(jobs.map(j => j.postedAt ?? j.createdAt).sort().slice(-1)[0] ?? null);

  const pooled = jobs.reduce((a, j) => {
    const c = j.outreachCounts;
    if (c) { a.sent += c.sent; a.connected += c.connected; a.replied += c.replied; }
    return a;
  }, { sent: 0, connected: 0, replied: 0 });
  const poolText = pooled.sent === 0 ? null
    : [pooled.replied ? `${pooled.replied} replied` : pooled.connected ? `${pooled.connected} connected` : "",
       `${pooled.sent} sent`].filter(Boolean).join(" · ");

  const sources = Array.from(new Set(jobs.map(j => SOURCE_LABEL[j.source] ?? j.source)));
  const anyReferral = jobs.some(j => j.applyType === "REFERRAL_FIRST");
  const openCount = jobs.filter(j => !j.closedAt).length;

  return (
    <div className="relative group">
      <button onClick={(e) => { e.stopPropagation(); multi ? toggleSelMany(ids) : toggleSel(ids[0]); }}
        aria-label={allSel ? "Deselect" : "Select"}
        className={`absolute top-2.5 right-2.5 z-10 w-5 h-5 rounded-md border flex items-center justify-center transition-all ${allSel ? "bg-primary border-primary text-primary-foreground opacity-100" : someSel ? "bg-primary/60 border-primary/60 text-primary-foreground opacity-100" : "bg-card border-input text-transparent hover:border-primary opacity-0 group-hover:opacity-100"}`}>
        <Check className="size-3" />
      </button>

      <div className={`w-full bg-card rounded-xl p-4 border shadow-sm transition-all ${allSel ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground/20 hover:shadow-md"}`}>
        <button onClick={() => openJob(primary)} className="w-full text-left">
          <div className="flex items-start gap-3">
            <Avatar className={`h-8 w-8 rounded-xl shrink-0 ${avatarClr(group.company)}`}>
              <AvatarFallback className={`rounded-xl text-xs font-bold ${avatarClr(group.company)}`}>
                {group.company.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1 text-sm font-semibold text-foreground truncate leading-tight">
                {jobs.some(j => j.pinned) && <Star className="size-3.5 shrink-0 text-primary fill-primary" />}
                <span className="truncate">{group.company}</span>
              </p>
              <p className="text-xs text-muted-foreground truncate mt-0.5 leading-tight">
                {multi ? `${jobs.length} roles · ${openCount} open` : primary.role}
              </p>
            </div>
            {maxScore !== null && (
              <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-lg shrink-0 mr-6 ${scoreClr(maxScore)}`}>
                {maxScore}
              </span>
            )}
          </div>
          {salText && (
            <p className="text-xs font-semibold mt-2 text-emerald-600 dark:text-emerald-400">
              {salText}<span className="text-muted-foreground font-normal ml-1.5">· est.</span>
            </p>
          )}
        </button>

        {multi && (
          <div className="space-y-1 mt-2.5">
            {jobs.map(j => {
              const closed = !!j.closedAt;
              const om = OUTREACH_META[j.outreachState];
              return (
                <div key={j.id}
                  className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 ${closed ? "bg-muted/50 border-border border-dashed" : "bg-card border-border"}`}>
                  <button onClick={(e) => { e.stopPropagation(); openJob(j); }}
                    className="flex-1 min-w-0 text-left flex items-center gap-1.5">
                    <span className={`text-[11px] font-medium truncate ${closed ? "text-muted-foreground line-through" : "text-foreground/80"}`}>
                      {shortRole(j.role)}
                    </span>
                    {!closed && om.text && (
                      <span className={`shrink-0 text-[9px] border rounded px-1 py-0.5 font-medium ${om.cls}`}>{om.text}</span>
                    )}
                    {j.directAppliedAt && (
                      <span className="shrink-0 inline-flex items-center gap-0.5 text-[9px] text-emerald-700 bg-emerald-100 dark:text-emerald-300 dark:bg-emerald-500/15 rounded px-1 py-0.5 font-medium"><CheckCheck className="size-2.5" /> applied</span>
                    )}
                    {closed && <span className="shrink-0 text-[9px] text-muted-foreground bg-muted rounded px-1 py-0.5">closed</span>}
                  </button>
                  <button title={closed ? "Reopen role" : "Close role — keeps contacts, stops new invites, redirects outreach to the open role"}
                    disabled={acting}
                    onClick={(e) => toggleRoleClosed(e, j.id, !closed)}
                    className={`shrink-0 w-5 h-5 rounded flex items-center justify-center transition-colors disabled:opacity-50 ${closed ? "text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-500/10" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
                    {closed ? <RotateCcw className="size-3" /> : <Ban className="size-3" />}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
          {sources.map(s => (
            <span key={s} className="text-[10px] text-muted-foreground bg-muted rounded-md px-2 py-1 font-medium">{s}</span>
          ))}
          {anyReferral && (
            <span className="text-[10px] text-violet-700 bg-violet-100 dark:text-violet-300 dark:bg-violet-500/15 rounded-md px-2 py-1 font-medium">Referral</span>
          )}
          {!multi && primary.directAppliedAt && (
            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700 bg-emerald-100 dark:text-emerald-300 dark:bg-emerald-500/15 rounded-md px-2 py-1 font-medium"><CheckCheck className="size-3" /> Applied</span>
          )}
          {!multi && OUTREACH_META[primary.outreachState].text && (
            <span className={`text-[10px] border rounded-md px-2 py-1 font-medium ${OUTREACH_META[primary.outreachState].cls}`}>
              {OUTREACH_META[primary.outreachState].text}
            </span>
          )}
          {poolText && (
            <span className="text-[10px] text-muted-foreground bg-muted/50 border border-border rounded-md px-2 py-1">{poolText}</span>
          )}
          {dateText && (
            <span className="text-[10px] text-muted-foreground ml-auto" title="Most recent posting date">{dateText}</span>
          )}
        </div>
      </div>

      {/* Hover quick-actions — operate on the primary (open) role */}
      <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
        <button title={primary.pinned ? "Unpin" : "Pin — always show in Apply Today"} disabled={acting}
          onClick={(e) => togglePinned(e, primary.id, !primary.pinned)}
          className={`w-7 h-7 rounded-lg bg-white/95 dark:bg-zinc-800/95 backdrop-blur border shadow-sm flex items-center justify-center disabled:opacity-50 transition-colors ${primary.pinned ? "border-primary/40 text-primary hover:bg-primary/10" : "border-border text-muted-foreground hover:bg-primary/10 hover:border-primary/40 hover:text-primary"}`}>
          <Star className={`size-3.5 ${primary.pinned ? "fill-primary" : ""}`} />
        </button>
        <button title={primary.directAppliedAt ? "Applied directly — click to undo" : "Applied directly?"} disabled={acting}
          onClick={(e) => { e.stopPropagation(); openApplied(primary); }}
          className={`w-7 h-7 rounded-lg bg-white/95 dark:bg-zinc-800/95 backdrop-blur border shadow-sm flex items-center justify-center disabled:opacity-50 transition-colors ${primary.directAppliedAt ? "border-emerald-300 text-emerald-600 dark:border-emerald-500/40 dark:text-emerald-300" : "border-border text-muted-foreground hover:bg-emerald-50 hover:border-emerald-300 hover:text-emerald-600 dark:hover:bg-emerald-500/15 dark:hover:border-emerald-500/40 dark:hover:text-emerald-300"}`}>
          <CheckCheck className="size-3.5" />
        </button>
        {primary.appStage === "NEW" && (
          <button title="Approve & queue outreach" disabled={acting}
            onClick={(e) => quickAct(e, primary.id, "approve")}
            className="w-7 h-7 rounded-lg bg-white/95 dark:bg-zinc-800/95 backdrop-blur border border-border shadow-sm flex items-center justify-center text-muted-foreground hover:bg-emerald-50 hover:border-emerald-300 hover:text-emerald-600 dark:hover:bg-emerald-500/15 dark:hover:border-emerald-500/40 dark:hover:text-emerald-300 disabled:opacity-50 transition-colors"><Check className="size-3.5" /></button>
        )}
        {(primary.appStage === "APPROVED" || primary.appStage === "OUTREACH") && (
          <button title="Mark replied" disabled={acting}
            onClick={(e) => quickAct(e, primary.id, "replied")}
            className="w-7 h-7 rounded-lg bg-white/95 dark:bg-zinc-800/95 backdrop-blur border border-border shadow-sm flex items-center justify-center text-muted-foreground hover:bg-emerald-50 hover:border-emerald-300 hover:text-emerald-600 dark:hover:bg-emerald-500/15 dark:hover:border-emerald-500/40 dark:hover:text-emerald-300 disabled:opacity-50 transition-colors"><CornerUpLeft className="size-3.5" /></button>
        )}
        {NEXT_STAGE[primary.appStage] && (
          <button title={NEXT_STAGE[primary.appStage]!.label} disabled={acting}
            onClick={(e) => quickAct(e, primary.id, NEXT_STAGE[primary.appStage]!.action)}
            className="w-7 h-7 rounded-lg bg-white/95 dark:bg-zinc-800/95 backdrop-blur border border-border shadow-sm flex items-center justify-center text-muted-foreground hover:bg-primary/10 hover:border-primary/40 hover:text-primary disabled:opacity-50 transition-colors"><ArrowRight className="size-3.5" /></button>
        )}
        <button title="Skip / remove from board" disabled={acting}
          onClick={(e) => quickAct(e, primary.id, "skip")}
          className="w-7 h-7 rounded-lg bg-white/95 dark:bg-zinc-800/95 backdrop-blur border border-border shadow-sm flex items-center justify-center text-muted-foreground hover:bg-muted hover:border-foreground/30 hover:text-foreground disabled:opacity-50 transition-colors"><X className="size-3.5" /></button>
        <button title={`Blacklist ${group.company}`} disabled={acting}
          onClick={(e) => blacklistCompany(e, group.company)}
          className="w-7 h-7 rounded-lg bg-white/95 dark:bg-zinc-800/95 backdrop-blur border border-border shadow-sm flex items-center justify-center text-muted-foreground hover:bg-red-50 hover:border-red-300 hover:text-red-600 dark:hover:bg-red-500/15 dark:hover:border-red-500/40 dark:hover:text-red-300 disabled:opacity-50 transition-colors"><Ban className="size-3.5" /></button>
      </div>
    </div>
  );
}
