"use client";

/**
 * Submit button for the job-detail send server action. Uses useFormStatus so the
 * owner gets a spinner + disabled state while the (slow) send runs — sendForJobs
 * fires LinkedIn invites/DMs inline. `kind` picks the label/icon; the parent form
 * carries the matching hidden `only` field so the action sends just that kind.
 */

import { useFormStatus } from "react-dom";
import { Send, UserPlus, Loader2 } from "lucide-react";

export function SendNowButton({ kind }: { kind: "invite" | "dm" }) {
  const { pending } = useFormStatus();
  const isDm = kind === "dm";
  const Icon = isDm ? Send : UserPlus;
  const label = isDm ? "Send DMs now" : "Send invites now";
  return (
    <button
      type="submit"
      disabled={pending}
      className={`inline-flex items-center gap-1.5 rounded-lg text-white text-xs font-semibold px-3 py-1.5 shadow-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
        isDm ? "bg-indigo-600 hover:bg-indigo-700" : "bg-zinc-600 hover:bg-zinc-700"
      }`}
    >
      {pending ? <><Loader2 className="size-3.5 animate-spin" /> Sending…</> : <><Icon className="size-3.5" /> {label}</>}
    </button>
  );
}
