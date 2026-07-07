"use client";

/**
 * Direct-application control for the job detail rail.
 *
 * Records that the owner applied DIRECTLY with the alternate-identity resume
 * (Job.directAppliedAt), independent of the referral pipeline. Confirming routes
 * through an AlertDialog → POST /api/jobs/applied, optimistic then router.refresh().
 * The alternate-resume download link is passed down from the server component.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, Download } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from "@/components/ui/alert-dialog";

export function DirectApplication({
  jobId,
  directAppliedAt,
  altResumeKey,
}: {
  jobId: string;
  directAppliedAt: string | null;
  altResumeKey: string | null;
}) {
  const router = useRouter();
  // Optimistic local state so the chip flips instantly; revert on write failure.
  const [applied, setApplied] = useState<boolean>(!!directAppliedAt);
  const [appliedAt, setAppliedAt] = useState<string | null>(directAppliedAt);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  const toggle = async () => {
    const next = !applied;
    setConfirming(false);
    setPending(true);
    setApplied(next);
    setAppliedAt(next ? new Date().toISOString() : null);
    const res = await fetch("/api/jobs/applied", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, applied: next }),
    }).catch(() => null);
    if (!res?.ok) {
      // Revert to the state we came from.
      setApplied(!next);
      setAppliedAt(!next ? new Date().toISOString() : null);
    } else {
      router.refresh();
    }
    setPending(false);
  };

  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-6">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground mb-1.5">
        <CheckCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" /> Direct application
      </h2>
      <p className="text-xs text-muted-foreground leading-relaxed mb-3">
        Applied directly with your alternate-identity resume — a second, independent candidacy alongside the referral outreach.
      </p>

      {applied ? (
        <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-300 mb-3">
          <CheckCheck className="size-4 shrink-0" />
          Applied directly{appliedAt ? ` on ${fmt(appliedAt)}` : ""}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground mb-3">Not applied directly yet.</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => setConfirming(true)}
          disabled={pending}
          className={`inline-flex items-center gap-1.5 text-sm font-semibold rounded-lg px-4 py-2 transition-colors shadow-sm disabled:opacity-60 ${
            applied
              ? "border border-border bg-card hover:bg-accent/50 text-muted-foreground shadow-none"
              : "bg-emerald-600 hover:bg-emerald-700 text-white"
          }`}
        >
          {applied ? "Undo" : <><CheckCheck className="size-3.5" /> Mark applied</>}
        </button>
        {altResumeKey && (
          <a
            href={`/api/resume/download?key=${encodeURIComponent(altResumeKey)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-indigo-800 dark:hover:text-indigo-300 transition-colors"
          >
            <Download className="size-3.5" /> Download alt resume
          </a>
        )}
      </div>

      <AlertDialog open={confirming} onOpenChange={(open: boolean) => { if (!open) setConfirming(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{applied ? "Undo direct application?" : "Applied directly?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {applied
                ? "This clears the record that you applied directly to this job with your alternate-identity resume."
                : "This records that you applied directly to this job using your alternate-identity resume (same content, alternate email + phone) — independent of the referral outreach."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {!applied && altResumeKey && (
            <a
              href={`/api/resume/download?key=${encodeURIComponent(altResumeKey)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-indigo-800 dark:hover:text-indigo-300 underline underline-offset-2"
            >
              <Download className="size-3.5" /> Download alt resume
            </a>
          )}
          <AlertDialogFooter>
            <button
              onClick={() => setConfirming(false)}
              className="inline-flex items-center justify-center text-sm font-medium text-muted-foreground border border-border rounded-lg px-4 py-2 hover:bg-accent/50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={toggle}
              className={`inline-flex items-center justify-center gap-1.5 text-sm font-semibold rounded-lg px-4 py-2 shadow-sm transition-colors ${
                applied
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : "bg-emerald-600 hover:bg-emerald-700 text-white"
              }`}
            >
              {applied ? "Undo" : <><CheckCheck className="size-3.5" /> Mark applied</>}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
