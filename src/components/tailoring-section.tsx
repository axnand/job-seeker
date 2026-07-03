"use client";

/**
 * Auto-tailoring panel for the job detail page (shown when job.needsTailoring).
 * Reads Job.tailorLog — written by src/resume/pipeline.ts — and offers:
 *   • status + per-edit why-lines when tailored (before → after in a Dialog)
 *   • the failure/no-edits detail line otherwise
 *   • a download link for the tailored PDF when it exists
 *   • Regenerate (AlertDialog-confirmed) → POST /api/jobs/tailor { force: true }
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Wand2,
  Check,
  Download,
  RefreshCw,
  TriangleAlert,
  CircleX,
  ArrowRight,
} from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from "@/components/ui/alert-dialog";

type TailorEdit = { find: string; replace: string; why: string };

type TailorLog = {
  status?: "tailored" | "no_edits" | "failed" | "skipped";
  detail?: string;
  edits?: TailorEdit[];
  rejected?: unknown[];
  repairs?: number;
  compileProvider?: string;
} | null;

export function TailoringSection({
  jobId,
  tailorLog,
  tailoredResumeKey,
}: {
  jobId: string;
  tailorLog: unknown;
  tailoredResumeKey: string | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const log = (tailorLog ?? null) as TailorLog;
  const status = log?.status;
  const edits = log?.edits ?? [];

  const regenerate = async () => {
    setConfirming(false);
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs/tailor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, force: true }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Tailoring failed (HTTP ${res.status}).`);
      } else if (!data?.ok) {
        setError(data?.outcome?.detail ?? "Tailoring did not produce a resume.");
      }
      router.refresh();
    } catch {
      setError("Tailoring request failed — check your connection and try again.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-6">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Wand2 className="size-3.5 text-primary" /> Auto-tailoring
        </h2>
        <button
          onClick={() => setConfirming(true)}
          disabled={running}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground border border-border rounded-lg px-3 py-1.5 hover:bg-accent/50 hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${running ? "animate-spin" : ""}`} />
          {running ? "Regenerating…" : status ? "Regenerate" : "Run tailoring"}
        </button>
      </div>

      {/* Status */}
      {!status && !running && (
        <p className="text-sm text-muted-foreground">
          Not run yet — the tailoring pipeline applies surgical, truthfulness-checked edits to your master LaTeX resume for this JD.
        </p>
      )}
      {running && (
        <p className="text-sm text-muted-foreground">Running — proposing edits, validating, and compiling…</p>
      )}

      {!running && status === "tailored" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/10 dark:border-emerald-500/30 rounded-xl px-3 py-2.5">
            <Check className="size-4 shrink-0" />
            Tailored — {edits.length} edit{edits.length !== 1 ? "s" : ""}
            {typeof log?.repairs === "number" && log.repairs > 0 ? `, ${log.repairs} compile repair${log.repairs !== 1 ? "s" : ""}` : ""}
            {log?.compileProvider ? ` · ${log.compileProvider}` : ""}
          </div>

          {edits.length > 0 && (
            <ul className="space-y-1.5">
              {edits.map((e, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <span className="mt-1 size-1 rounded-full bg-primary shrink-0" />
                  <span className="leading-relaxed">{e.why || "(no rationale given)"}</span>
                </li>
              ))}
            </ul>
          )}

          {edits.length > 0 && (
            <Dialog>
              <DialogTrigger className="text-xs font-medium text-primary hover:text-indigo-800 dark:hover:text-indigo-300 underline underline-offset-2 transition-colors">
                View before → after
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Applied edits</DialogTitle>
                  <DialogDescription>
                    Each edit is an exact find → replace on the master .tex, validated against the truthfulness vocabulary.
                  </DialogDescription>
                </DialogHeader>
                <div className="max-h-[60vh] overflow-y-auto scrollbar-slim space-y-3">
                  {edits.map((e, i) => (
                    <div key={i} className="rounded-xl border border-border bg-muted/50 p-3 space-y-2">
                      <p className="text-xs font-medium text-foreground">{e.why || `Edit ${i + 1}`}</p>
                      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                        <pre className="text-[11px] leading-relaxed text-red-800 bg-red-50 border border-red-200 dark:text-red-300 dark:bg-red-500/10 dark:border-red-500/30 rounded-lg p-2 whitespace-pre-wrap break-words overflow-x-auto">{e.find}</pre>
                        <ArrowRight className="size-3.5 text-muted-foreground shrink-0" />
                        <pre className="text-[11px] leading-relaxed text-emerald-800 bg-emerald-50 border border-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/10 dark:border-emerald-500/30 rounded-lg p-2 whitespace-pre-wrap break-words overflow-x-auto">{e.replace}</pre>
                      </div>
                    </div>
                  ))}
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>
      )}

      {!running && (status === "failed" || status === "no_edits" || status === "skipped") && (
        <div
          className={`flex items-start gap-2 text-sm rounded-xl px-3 py-2.5 border ${
            status === "failed"
              ? "text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-500/10 dark:border-red-500/30"
              : "text-amber-800 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/30"
          }`}
        >
          {status === "failed"
            ? <CircleX className="size-4 shrink-0 mt-0.5" />
            : <TriangleAlert className="size-4 shrink-0 mt-0.5" />}
          <span className="leading-relaxed">
            <span className="font-medium capitalize">{status.replace("_", " ")}</span>
            {log?.detail ? ` — ${log.detail}` : ""}
          </span>
        </div>
      )}

      {error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-300">{error}</p>
      )}

      {tailoredResumeKey && (
        <a
          href={`/api/resume/download?key=${encodeURIComponent(tailoredResumeKey)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-indigo-800 dark:hover:text-indigo-300 transition-colors"
        >
          <Download className="size-3.5" /> Download tailored PDF
        </a>
      )}

      {/* Regenerate confirmation */}
      <AlertDialog open={confirming} onOpenChange={(open: boolean) => { if (!open) setConfirming(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate tailored resume?</AlertDialogTitle>
            <AlertDialogDescription>
              This discards the previous tailoring attempt (edits and PDF) and reruns
              the pipeline from your master LaTeX resume. It can take a couple of minutes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <button
              onClick={() => setConfirming(false)}
              className="inline-flex items-center justify-center text-sm font-medium text-muted-foreground border border-border rounded-lg px-4 py-2 hover:bg-accent/50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={regenerate}
              className="inline-flex items-center justify-center gap-1.5 text-sm font-semibold text-primary-foreground bg-primary hover:bg-primary/90 rounded-lg px-4 py-2 shadow-sm transition-colors"
            >
              <RefreshCw className="size-3.5" /> Regenerate
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
