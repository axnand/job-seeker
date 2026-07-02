"use client";

import { useEffect, useState, useRef } from "react";
import { CircleX, X, Upload, FileUp, FileText, Info } from "lucide-react";
import { PageHeader } from "@/components/page-header";

type BaseResume = { baseResumeKey: string | null; name: string | null; url: string | null };

export default function ResumePage() {
  const [resume, setResume] = useState<BaseResume | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/resume/base").then(r => r.json()).then(setResume).catch(() => setResume({ baseResumeKey: null, name: null, url: null }));
  }, []);

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
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg border bg-red-50 border-red-200 text-red-700">
          <CircleX className="size-4 shrink-0" /> {error}
          <button onClick={() => setError(null)} aria-label="Dismiss" className="ml-1 opacity-50 hover:opacity-100"><X className="size-3.5" /></button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto scrollbar-slim">
        <div className="mx-auto w-full max-w-2xl px-6 py-10 space-y-6">
          <p className="text-sm text-zinc-500">
            Your base resume is used for every application by default. When the AI decides a specific job
            would benefit from tailoring, it tells you exactly what to change and asks you to upload a tailored
            version for that job — outreach waits until you do.
          </p>

          {/* Base resume card */}
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-6">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-4">Base resume</p>

            {resume?.baseResumeKey ? (
              <div className="flex items-center justify-between gap-4 p-4 rounded-xl border border-zinc-200 bg-zinc-50">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex size-11 items-center justify-center rounded-lg bg-white border border-zinc-200 text-zinc-400 shrink-0">
                    <FileText className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-900 truncate">{resume.name ?? "resume.pdf"}</p>
                    <p className="text-xs text-zinc-400">Used as the default for all jobs</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {resume.url && (
                    <a href={resume.url} target="_blank" rel="noopener noreferrer"
                      className="text-xs font-medium text-zinc-600 border border-zinc-200 rounded-lg px-3 py-2 hover:bg-white transition-colors">
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
                className="w-full flex flex-col items-center justify-center gap-2 p-10 rounded-xl border-2 border-dashed border-zinc-200 hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors">
                <span className="flex size-10 items-center justify-center rounded-full bg-indigo-50 text-primary">
                  <FileUp className="size-5" />
                </span>
                <span className="text-sm font-medium text-zinc-700">{uploading ? "Uploading…" : "Upload your resume (PDF)"}</span>
                <span className="text-xs text-zinc-400">This becomes your default for every application</span>
              </button>
            )}

            <input ref={fileRef} type="file" accept="application/pdf" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} />
          </div>

          <div className="flex gap-3 bg-indigo-50/60 border border-indigo-100 rounded-xl p-4">
            <Info className="size-4 shrink-0 text-primary mt-0.5" />
            <div>
              <p className="text-sm text-indigo-950 font-medium mb-1">How tailoring works</p>
              <p className="text-xs text-indigo-900/70 leading-relaxed">
                Each job is checked automatically. Most use your base resume as-is. For the few that need tailoring,
                you&apos;ll see the exact suggested edits on the job and an upload slot for the tailored PDF. The system
                never edits or fabricates anything — you stay in control of your resume.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
