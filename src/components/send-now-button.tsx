"use client";

/**
 * Submit button for the job-detail "Send DMs now" server action. Uses
 * useFormStatus so the owner gets a spinner + disabled state while the (slow)
 * send runs — sendForJobs fires LinkedIn DMs/invites inline.
 */

import { useFormStatus } from "react-dom";
import { Send, Loader2 } from "lucide-react";

export function SendNowButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-3 py-1.5 shadow-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {pending ? <><Loader2 className="size-3.5 animate-spin" /> Sending…</> : <><Send className="size-3.5" /> Send DMs now</>}
    </button>
  );
}
