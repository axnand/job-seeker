"use client";

/**
 * Submit control + progress overlay for the Add-job form.
 *
 * The addJob server action does real work — URL fetch, post extraction, job-ID
 * resolution, AI scoring, salary normalize, create + approve + enqueue outreach
 * (maxDuration 60s). A plain form gives zero feedback while that runs, so this
 * reads useFormStatus() to flip the button into a spinner and drop a blocking
 * overlay that cycles through the pipeline steps so the wait reads as progress.
 */

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Sparkles, Loader2 } from "lucide-react";

// Roughly mirrors the addJob pipeline order; timed cross-fade so the long wait
// (people-search on referral mode is the slow part) doesn't feel frozen.
const STEPS = [
  "Reading the post…",
  "Extracting company & role…",
  "Grabbing the job ID from the apply link…",
  "Scoring against your resume…",
  "Lining up referrals…",
  "Almost there…",
];

export function AddJobSubmit() {
  const { pending } = useFormStatus();
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!pending) {
      setStep(0);
      return;
    }
    // Advance but hold on the final "almost there" so we never claim to finish.
    const id = setInterval(() => {
      setStep((s) => Math.min(s + 1, STEPS.length - 1));
    }, 2500);
    return () => clearInterval(id);
  }, [pending]);

  return (
    <>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium px-4 py-2 rounded-lg shadow-sm transition-colors disabled:opacity-70 disabled:cursor-not-allowed"
      >
        {pending ? (
          <><Loader2 className="size-4 animate-spin" /> Adding…</>
        ) : (
          <><Sparkles className="size-4" /> Score &amp; add</>
        )}
      </button>

      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card px-8 py-7 shadow-xl">
            <span className="flex size-11 items-center justify-center rounded-full bg-indigo-50 dark:bg-indigo-500/10 text-primary">
              <Loader2 className="size-5 animate-spin" />
            </span>
            <div className="text-center">
              <p className="text-sm font-semibold text-foreground">Adding your job</p>
              <p className="mt-1 text-xs text-muted-foreground transition-opacity duration-300">{STEPS[step]}</p>
            </div>
            <p className="text-[11px] text-muted-foreground">This can take up to a minute — hang tight.</p>
          </div>
        </div>
      )}
    </>
  );
}
