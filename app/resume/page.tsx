"use client";

import { useEffect, useState, useRef } from "react";

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
    <div className="max-w-2xl mx-auto px-6 py-10 space-y-6">
      {error && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg border bg-red-50 border-red-200 text-red-700">
          <span>⛔</span> {error}
          <button onClick={() => setError(null)} className="ml-1 opacity-50 hover:opacity-100">×</button>
        </div>
      )}
      <div>
        <h1 className="text-xl font-bold text-zinc-900">Resume</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Your base resume is used for every application by default. When the AI decides a specific job
          would benefit from tailoring, it tells you exactly what to change and asks you to upload a tailored
          version for that job — outreach waits until you do.
        </p>
      </div>

      {/* Base resume card */}
      <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-6">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-4">Base resume</p>

        {resume?.baseResumeKey ? (
          <div className="flex items-center justify-between gap-4 p-4 rounded-xl border border-zinc-200 bg-zinc-50">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-12 rounded-lg bg-red-50 border border-red-100 flex items-center justify-center text-red-500 text-xs font-bold shrink-0">PDF</div>
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
                className="text-xs font-medium text-white bg-zinc-900 hover:bg-zinc-700 rounded-lg px-3 py-2 transition-colors">
                {uploading ? "Uploading…" : "Replace"}
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => fileRef.current?.click()} disabled={uploading}
            className="w-full flex flex-col items-center justify-center gap-2 p-10 rounded-xl border-2 border-dashed border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 transition-colors">
            <span className="text-2xl">↑</span>
            <span className="text-sm font-medium text-zinc-700">{uploading ? "Uploading…" : "Upload your resume (PDF)"}</span>
            <span className="text-xs text-zinc-400">This becomes your default for every application</span>
          </button>
        )}

        <input ref={fileRef} type="file" accept="application/pdf" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} />
      </div>

      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
        <p className="text-sm text-blue-900 font-medium mb-1">How tailoring works</p>
        <p className="text-xs text-blue-700 leading-relaxed">
          Each job is checked automatically. Most use your base resume as-is. For the few that need tailoring,
          you&apos;ll see the exact suggested edits on the job and an upload slot for the tailored PDF. The system
          never edits or fabricates anything — you stay in control of your resume.
        </p>
      </div>
    </div>
  );
}
