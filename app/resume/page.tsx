"use client";

import { useEffect, useState, useRef } from "react";
import { CircleX, X, Upload, FileUp, FileText, FileCode2, Info, Check, Loader2, Contact, Download, Eye } from "lucide-react";
import { PageHeader } from "@/components/page-header";

type BaseResume = { baseResumeKey: string | null; name: string | null; url: string | null };
type MasterInfo = { hasMasterTex: boolean; masterTex: string; masterUrl: string | null; vocabularySize: number; updatedAt: string | null };

/** Inline PDF preview. Presigned S3 (or blob) URLs render directly in an iframe. */
function PdfPreview({ url, label, height = "h-[420px]" }: { url: string | null; label: string; height?: string }) {
  return (
    <div className="rounded-xl border border-border bg-muted/30 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/50">
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{label}</span>
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:text-indigo-800 dark:hover:text-indigo-300 transition-colors">
            <Eye className="size-3" /> Open
          </a>
        )}
      </div>
      {url ? (
        <iframe src={url} title={label} className={`w-full ${height} bg-white`} />
      ) : (
        <div className={`flex items-center justify-center ${height} text-xs text-muted-foreground`}>
          No preview yet
        </div>
      )}
    </div>
  );
}

export default function ResumePage() {
  const [resume, setResume] = useState<BaseResume | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Master LaTeX resume (source for automated tailoring)
  const [master, setMaster] = useState<MasterInfo | null>(null);
  const [masterTex, setMasterTex] = useState("");
  const [masterUrl, setMasterUrl] = useState<string | null>(null);
  const [savingTex, setSavingTex] = useState(false);
  const [texSaved, setTexSaved] = useState(false);
  const [texError, setTexError] = useState<string | null>(null);
  const [compileLog, setCompileLog] = useState<string | null>(null);

  // Live compile preview (unsaved .tex → PDF, rendered on our end)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLog, setPreviewLog] = useState<string | null>(null);

  // Alternate-identity resume (direct-application strategy)
  const [altEmail, setAltEmail] = useState("");
  const [altPhone, setAltPhone] = useState("");
  const [altKey, setAltKey] = useState<string | null>(null);
  const [altUrl, setAltUrl] = useState<string | null>(null);
  const [altGenerating, setAltGenerating] = useState(false);
  const [altError, setAltError] = useState<string | null>(null);
  const [altSaved, setAltSaved] = useState(false);

  useEffect(() => {
    fetch("/api/resume/base").then(r => r.json()).then(setResume).catch(() => setResume({ baseResumeKey: null, name: null, url: null }));
    fetch("/api/resume/master").then(r => r.json()).then((d: MasterInfo) => {
      setMaster(d);
      if (d?.masterTex) setMasterTex(d.masterTex); // show the latest saved source
      setMasterUrl(d?.masterUrl ?? null);
    }).catch(() => setMaster({ hasMasterTex: false, masterTex: "", masterUrl: null, vocabularySize: 0, updatedAt: null }));
    fetch("/api/resume/alt").then(r => r.json()).then(d => {
      setAltKey(d?.altResumeKey ?? null);
      setAltUrl(d?.altUrl ?? null);
      if (d?.altIdentity?.email) setAltEmail(d.altIdentity.email);
      if (d?.altIdentity?.phone) setAltPhone(d.altIdentity.phone);
    }).catch(() => {});
  }, []);

  // Revoke the previous blob URL whenever the live preview changes / unmounts.
  useEffect(() => () => { if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  async function generateAlt() {
    if (!altEmail.trim() || !altPhone.trim()) return;
    setAltGenerating(true);
    setAltError(null);
    setAltSaved(false);
    try {
      const res = await fetch("/api/resume/alt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: altEmail, phone: altPhone }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.altResumeKey) {
        setAltKey(data.altResumeKey);
        setAltUrl(data.altUrl ?? null);
        setAltSaved(true);
        setTimeout(() => setAltSaved(false), 8000);
      } else {
        // Surface the server's message verbatim (422 = compile/sanity failure).
        setAltError(data?.error ?? `Generation failed (HTTP ${res.status}).`);
      }
    } catch {
      setAltError("Generation failed — check your connection and try again.");
    } finally {
      setAltGenerating(false);
    }
  }

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
        setMaster({ hasMasterTex: true, masterTex, masterUrl: data.masterUrl ?? null, vocabularySize: data.vocabularySize ?? 0, updatedAt: new Date().toISOString() });
        setMasterUrl(data.masterUrl ?? null);
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

  // Compile the current (unsaved) .tex on our server and preview the PDF inline.
  async function previewMasterTex() {
    if (!masterTex.trim()) return;
    setPreviewing(true);
    setPreviewError(null);
    setPreviewLog(null);
    try {
      const res = await fetch("/api/resume/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tex: masterTex }),
      });
      if (res.ok) {
        const blob = await res.blob();
        setPreviewUrl(URL.createObjectURL(blob)); // effect revokes the old one
      } else {
        const data = await res.json().catch(() => null);
        setPreviewError(data?.error ?? `Preview failed (HTTP ${res.status}).`);
        if (data?.log) setPreviewLog(data.log);
      }
    } catch {
      setPreviewError("Preview failed — check your connection and try again.");
    } finally {
      setPreviewing(false);
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

            {/* Left rail — base PDF + alt identity, each with an inline preview */}
            <div className="space-y-6">

          {/* Base resume card */}
          <div className="bg-card rounded-2xl border border-border shadow-sm p-6">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">Base resume</p>

            {resume?.baseResumeKey ? (
              <div className="space-y-4">
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
                  <button onClick={() => fileRef.current?.click()} disabled={uploading}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-lg px-3 py-2 transition-colors disabled:opacity-60 shrink-0">
                    <Upload className="size-3.5" /> {uploading ? "Uploading…" : "Replace"}
                  </button>
                </div>
                <PdfPreview url={resume.url} label="Base resume (default identity)" height="h-72" />
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

          {/* Alternate identity card — for the direct-application strategy */}
          <div className="bg-card rounded-2xl border border-border shadow-sm p-6">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-1.5">
              <Contact className="size-3.5 text-primary" /> Alternate identity
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed mb-4">
              A second copy of your resume with a different email + phone — for applying to jobs directly, as a candidacy independent of your referral outreach.
            </p>

            <div className="space-y-3">
              <div>
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Alternate email</label>
                <input type="email" value={altEmail} onChange={e => setAltEmail(e.target.value)}
                  placeholder="you.alt@example.com"
                  className="mt-1 w-full rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring transition" />
              </div>
              <div>
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Alternate phone</label>
                <input type="tel" value={altPhone} onChange={e => setAltPhone(e.target.value)}
                  placeholder="+91 90000 00000"
                  className="mt-1 w-full rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring transition" />
              </div>
            </div>

            <button onClick={generateAlt} disabled={altGenerating || !altEmail.trim() || !altPhone.trim()}
              className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-lg px-3 py-2 transition-colors disabled:opacity-60">
              {altGenerating
                ? <><Loader2 className="size-3.5 animate-spin" /> Generating…</>
                : <><Upload className="size-3.5" /> {altKey ? "Regenerate alt resume" : "Generate alt resume"}</>}
            </button>

            {altSaved && (
              <p className="mt-3">
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/10 dark:border-emerald-500/30 rounded-md px-2 py-1">
                  <Check className="size-3.5" /> Alternate resume generated
                </span>
              </p>
            )}
            {altError && (
              <p className="mt-3 flex items-start gap-1.5 text-xs font-medium text-red-600 dark:text-red-300">
                <CircleX className="size-3.5 shrink-0 mt-0.5" /> {altError}
              </p>
            )}

            {altKey && (
              <div className="mt-4 space-y-3">
                <PdfPreview url={altUrl} label="Alternate identity resume" height="h-72" />
                <a href={`/api/resume/download?key=${encodeURIComponent(altKey)}`} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-indigo-800 dark:hover:text-indigo-300 transition-colors">
                  <Download className="size-3.5" /> Download alt resume
                </a>
              </div>
            )}

            <p className="mt-3 text-xs text-muted-foreground leading-relaxed">
              Built from your master LaTeX resume — same content, only the contact block changes. Save the master .tex first.
            </p>
          </div>
            </div>{/* end left rail */}

            {/* Main column — master LaTeX editor + preview */}
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
              The latest saved source loads below — edit it directly. It&apos;s compile-checked before saving, and its
              wording becomes the truthfulness vocabulary; auto-tailoring can only rephrase what&apos;s already here,
              never invent claims. Compilation runs on external LaTeX services (xelatex when the source uses
              <span className="font-mono"> fontspec</span>, otherwise pdflatex) — hit <span className="font-medium">Preview</span> to
              render the PDF here without saving.
            </p>

            <div className="grid gap-4 lg:grid-cols-2">
              <textarea
                value={masterTex}
                onChange={e => setMasterTex(e.target.value)}
                rows={22}
                spellCheck={false}
                placeholder={"\\documentclass{article}\n…paste your full LaTeX resume source…\n\\begin{document}\n…\n\\end{document}"}
                className="w-full rounded-xl border border-border bg-muted/50 px-4 py-3 text-xs font-mono leading-relaxed resize-y outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring placeholder:text-muted-foreground transition"
              />
              {/* Preview pane: live compile if present, else the saved master PDF */}
              <PdfPreview
                url={previewUrl ?? masterUrl}
                label={previewUrl ? "Live preview (unsaved)" : "Saved master PDF"}
                height="h-[520px]"
              />
            </div>

            <div className="flex flex-wrap items-center gap-3 mt-3">
              <button
                onClick={saveMasterTex}
                disabled={savingTex || !masterTex.trim()}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-lg px-3 py-2 transition-colors disabled:opacity-60"
              >
                {savingTex
                  ? <><Loader2 className="size-3.5 animate-spin" /> Compiling…</>
                  : <><Upload className="size-3.5" /> {master?.hasMasterTex ? "Replace master .tex" : "Save master .tex"}</>}
              </button>
              <button
                onClick={previewMasterTex}
                disabled={previewing || !masterTex.trim()}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground border border-border rounded-lg px-3 py-2 hover:bg-accent/50 hover:text-foreground transition-colors disabled:opacity-60"
              >
                {previewing
                  ? <><Loader2 className="size-3.5 animate-spin" /> Compiling preview…</>
                  : <><Eye className="size-3.5" /> Preview</>}
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
              {previewError && !previewLog && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-300">
                  <CircleX className="size-3.5" /> {previewError}
                </span>
              )}
            </div>

            {(compileLog || previewLog) && (
              <div className="mt-3 rounded-xl border border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10 overflow-hidden">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-red-700 dark:text-red-300 px-4 pt-3">
                  <CircleX className="size-3.5 shrink-0" /> {compileLog ? (texError ?? "Master resume does not compile") : (previewError ?? "Preview does not compile")}
                </p>
                <pre className="text-[11px] text-red-900/80 dark:text-red-200 font-mono leading-relaxed whitespace-pre-wrap px-4 py-3 max-h-64 overflow-y-auto scrollbar-slim">
                  {compileLog ?? previewLog}
                </pre>
              </div>
            )}
          </div>

          <div className="flex gap-3 bg-indigo-50/60 dark:bg-indigo-500/10 border border-indigo-100 dark:border-indigo-500/20 rounded-xl p-4">
            <Info className="size-4 shrink-0 text-primary mt-0.5" />
            <div>
              <p className="text-sm text-indigo-950 dark:text-indigo-200 font-medium mb-1">How tailoring works</p>
              <p className="text-xs text-indigo-900/70 dark:text-indigo-300 leading-relaxed">
                Each job is checked automatically. For the few that need tailoring, the pipeline applies surgical,
                truthfulness-checked edits to your master .tex — and produces both the referral resume and an
                alternate-identity copy of the same edits for the direct application. You&apos;ll see the exact edits
                on the job, and the system never fabricates anything.
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
