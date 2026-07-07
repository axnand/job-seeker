"use client";

/**
 * Referral marker for the job detail rail.
 *
 * Records that a referral actually landed for this job (Job.referredAt) — someone
 * agreed to refer the owner or submitted them. A standalone MARKER, independent of
 * the direct application (Job.directAppliedAt) and of the outreach pipeline: a job
 * can be Referred and/or Applied and/or mid-outreach all at once, and marking it
 * neither stops nor alters outreach. Confirming routes through an AlertDialog →
 * POST /api/jobs/referred, optimistic then router.refresh().
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserCheck } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from "@/components/ui/alert-dialog";

export function ReferralMarker({
  jobId,
  referredAt,
}: {
  jobId: string;
  referredAt: string | null;
}) {
  const router = useRouter();
  // Optimistic local state so the chip flips instantly; revert on write failure.
  const [referred, setReferred] = useState<boolean>(!!referredAt);
  const [referredAtState, setReferredAtState] = useState<string | null>(referredAt);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  const toggle = async () => {
    const next = !referred;
    setConfirming(false);
    setPending(true);
    setReferred(next);
    setReferredAtState(next ? new Date().toISOString() : null);
    const res = await fetch("/api/jobs/referred", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, referred: next }),
    }).catch(() => null);
    if (!res?.ok) {
      // Revert to the state we came from.
      setReferred(!next);
      setReferredAtState(!next ? new Date().toISOString() : null);
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
        <UserCheck className="size-3.5 text-indigo-600 dark:text-indigo-400" /> Referral
      </h2>
      <p className="text-xs text-muted-foreground leading-relaxed mb-3">
        A referral landed — someone agreed to refer you or submitted you. A standalone marker, separate from the direct application and the outreach pipeline.
      </p>

      {referred ? (
        <p className="flex items-center gap-1.5 text-sm font-medium text-indigo-700 dark:text-indigo-300 mb-3">
          <UserCheck className="size-4 shrink-0" />
          Referred{referredAtState ? ` on ${fmt(referredAtState)}` : ""}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground mb-3">No referral yet.</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => setConfirming(true)}
          disabled={pending}
          className={`inline-flex items-center gap-1.5 text-sm font-semibold rounded-lg px-4 py-2 transition-colors shadow-sm disabled:opacity-60 ${
            referred
              ? "border border-border bg-card hover:bg-accent/50 text-muted-foreground shadow-none"
              : "bg-indigo-600 hover:bg-indigo-700 text-white"
          }`}
        >
          {referred ? "Undo" : <><UserCheck className="size-3.5" /> Mark referred</>}
        </button>
      </div>

      <AlertDialog open={confirming} onOpenChange={(open: boolean) => { if (!open) setConfirming(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{referred ? "Undo referral?" : "Referred?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {referred
                ? "This clears the record that a referral landed for this job."
                : "This records that a referral landed for this job — someone agreed to refer you or submitted you. It's a standalone marker and does not stop or alter your outreach."}
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
              onClick={toggle}
              className={`inline-flex items-center justify-center gap-1.5 text-sm font-semibold rounded-lg px-4 py-2 shadow-sm transition-colors ${
                referred
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : "bg-indigo-600 hover:bg-indigo-700 text-white"
              }`}
            >
              {referred ? "Undo" : <><UserCheck className="size-3.5" /> Mark referred</>}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
