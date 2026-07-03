"use client";

import { useEffect, useState, useRef } from "react";
import { CircleX, X, Upload, FileUp, FileText, FileCode2, Info, Check, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";

type BaseResume = { baseResumeKey: string | null; name: string | null; url: string | null };
type MasterInfo = { hasMasterTex: boolean; vocabularySize: number; updatedAt: string | null };

export default function ResumePage() {
  const [resume, setResume] = useState<BaseResume | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Master LaTeX resume (source for automated tailoring)
  const [master, setMaster] = useState<MasterInfo | null>(null);
  const [masterTex, setMasterTex] = useState("");
  const [savingTex, setSavingTex] = useState(false);
  const [texSaved, setTexSaved] = useState(false);
  const [texError, setTexError] = useState<string | null>(null);
  const [compileLog, setCompileLog] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/resume/base").then(r => r.json()).then(setResume).catch(() => setResume({ baseResumeKey: null, name: null, url: null }));
    fetch("/api/resume/master").then(r => r.json()).then(setMaster).catch(() => setMaster({ hasMasterTex: false, vocabularySize: 0, updatedAt: null }));
  }, []);

  async function saveMasterTex() {
    if (!masterTex.trim()) return;
    setSavingTex(true);
    setTexError(null);
    setCompileLog(null);
    setTexSaved(false);
    try {
      const res = await fetch("/api/resume/master", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ masterTex }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setMaster({ hasMasterTex: true, vocabularySize: data.vocabularySize ?? 0, updatedAt: new Date().toISOString() });
        setTexSaved(true);
        setTimeout(() => setTexSaved(false), 6000);
      } else {
        setTexError(data?.error ?? `Save failed (HTTP ${res.status}).`);
        if (data?.compileLog) setCompileLog(data.compileLog);
      }
    } catch {
      setTexError("Save failed — check your connection and try again.");
    } finally {
      setSavingTex(false);
    }
  }

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/resume/base", { method: "POST", body: fd }).then(r => r.json()).catch(() => null);
    setUploading(false);
    if (res?.ok) setResume({ baseResumeKey: res.baseResumeKey, name: res.name, url: res.url });
    else {
      setError(res?.error ?? "Upload failed");
      setTimeout(() => setError(null), 4500);
    }
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <PageHeader title="Resume" subtitle="Your default resume for every application" icon={<FileText className="size-4" />} />

      {error && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg border bg-red-50 border-red-200 text-red-700 dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-300">
          <CircleX className="size-4 shrink-0" /> {error}
          <button onClick={() => setError(null)} aria-label="Dismiss" className="ml-1 opacity-50 hover:opacity-100"><X className="size-3.5" /></button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto scrollbar-slim">
        <div className="mx-auto w-full max-w-6xl px-6 py-10 lg:px-10">
          <p className="mb-6 max-w-3xl text-sm text-muted-foreground">
            Your base resume is used for every application by default. When the AI decides a specific job
            would benefit from tailoring, it tells you exactly what to change and asks you to upload a tailored
            version for that job — outreach waits until you do.
          </p>

          <div className="grid items-start gap-6 md:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">

            {/* Left rail — base PDF + how it works */}
            <div className="space-y-6">

          {/* Base resume card */}
          <div className="bg-card rounded-2xl border border-border shadow-sm p-6">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">Base resume</p>

            {resume?.baseResumeKey ? (
              <div className="flex items-center justify-between gap-4 p-4 rounded-xl border border-border bg-muted/50">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex size-11 items-center justify-center rounded-lg bg-card border border-border text-muted-foreground shrink-0">
                    <FileText className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{resume.name ?? "resume.pdf"}</p>
                    <p className="text-xs text-muted-foreground">Used as the default for all jobs</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {resume.url && (
                    <a href={resume.url} target="_blank" rel="noopener noreferrer"
                      className="text-xs font-medium text-muted-foreground border border-border rounded-lg px-3 py-2 hover:bg-card transition-colors">
                      View
                    </a>
                  )}
                  <button onClick={() => fileRef.current?.click()} disabled={uploading}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-lg px-3 py-2 transition-colors disabled:opacity-60">
                    <Upload className="size-3.5" /> {uploading ? "Uploading…" : "Replace"}
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => fileRef.current?.click()} disabled={uploading}
                className="w-full flex flex-col items-center justify-center gap-2 p-10 rounded-xl border-2 border-dashed border-border hover:border-indigo-300 dark:hover:border-indigo-500/40 hover:bg-indigo-50/40 dark:hover:bg-indigo-500/10 transition-colors">
                <span className="flex size-10 items-center justify-center rounded-full bg-indigo-50 dark:bg-indigo-500/10 text-primary">
                  <FileUp className="size-5" />
                </span>
                <span className="text-sm font-medium text-foreground">{uploading ? "Uploading…" : "Upload your resume (PDF)"}</span>
                <span className="text-xs text-muted-foreground">This becomes your default for every application</span>
              </button>
            )}

            <input ref={fileRef} type="file" accept="application/pdf" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} />

            <p className="text-xs text-muted-foreground mt-3">
              The PDF stays as the outreach fallback — it&apos;s what gets sent when a job needs no tailoring
              (or tailoring fails).
            </p>
          </div>
            </div>{/* end left rail */}

            {/* Main column — master LaTeX editor */}
            <div className="min-w-0 space-y-6">
          {/* Master LaTeX resume card — source for automated tailoring */}
          <div className="bg-card rounded-2xl border border-border shadow-sm p-6">
            <div className="flex items-center justify-between gap-3 mb-1.5">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                <FileCode2 className="size-3.5 text-primary" /> Master LaTeX resume
              </p>
              {master?.hasMasterTex && (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/10 dark:border-emerald-500/30 rounded-md px-2 py-0.5">
                  <Check className="size-3" /> Saved
                  {master.vocabularySize > 0 && ` · ${master.vocabularySize.toLocaleString()} vocabulary terms`}
                  {master.updatedAt && ` · ${new Date(master.updatedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed mb-4">
              Paste the complete .tex source. It&apos;s compile-checked before saving, and its wording becomes the
              truthfulness vocabulary — auto-tailoring can only rephrase what&apos;s already here, never invent claims.
            </p>

            <textarea
              value={masterTex}
              onChange={e => setMasterTex(e.target.value)}
              rows={12}
              spellCheck={false}
              placeholder={"\\documentclass{article}\n…paste your full LaTeX resume source…\n\\begin{document}\n…\n\\end{document}"}
              className="w-full rounded-xl border border-border bg-muted/50 px-4 py-3 text-xs font-mono leading-relaxed resize-y outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring placeholder:text-muted-foreground transition"
            />

            <div className="flex items-center gap-3 mt-3">
              <button
                onClick={saveMasterTex}
                disabled={savingTex || !masterTex.trim()}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-lg px-3 py-2 transition-colors disabled:opacity-60"
              >
                {savingTex
                  ? <><Loader2 className="size-3.5 animate-spin" /> Compiling…</>
                  : <><Upload className="size-3.5" /> {master?.hasMasterTex ? "Replace master .tex" : "Save master .tex"}</>}
              </button>
              {texSaved && master && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                  <Check className="size-3.5" /> Compiled &amp; saved — {master.vocabularySize.toLocaleString()} vocabulary terms
                </span>
              )}
              {texError && !compileLog && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-300">
                  <CircleX className="size-3.5" /> {texError}
                </span>
              )}
            </div>

            {compileLog && (
              <div className="mt-3 rounded-xl border border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10 overflow-hidden">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-red-700 dark:text-red-300 px-4 pt-3">
                  <CircleX className="size-3.5 shrink-0" /> {texError ?? "Master resume does not compile"}
                </p>
                <pre className="text-[11px] text-red-900/80 dark:text-red-200 font-mono leading-relaxed whitespace-pre-wrap px-4 py-3 max-h-64 overflow-y-auto scrollbar-slim">
                  {compileLog}
                </pre>
              </div>
            )}
          </div>

          <div className="flex gap-3 bg-indigo-50/60 dark:bg-indigo-500/10 border border-indigo-100 dark:border-indigo-500/20 rounded-xl p-4">
            <Info className="size-4 shrink-0 text-primary mt-0.5" />
            <div>
              <p className="text-sm text-indigo-950 dark:text-indigo-200 font-medium mb-1">How tailoring works</p>
              <p className="text-xs text-indigo-900/70 dark:text-indigo-300 leading-relaxed">
                Each job is checked automatically. Most use your base resume as-is. For the few that need tailoring,
                you&apos;ll see the exact suggested edits on the job and an upload slot for the tailored PDF. The system
                never edits or fabricates anything — you stay in control of your resume.
              </p>
            </div>
          </div>{/* end how-tailoring-works */}
            </div>{/* end main column */}
          </div>{/* end grid */}
        </div>
      </div>
    </div>
  );
}
