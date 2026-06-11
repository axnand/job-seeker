/**
 * Account safety — trip the global pause on Unipile distress signals
 * (429 / account_restricted / limit_exceeded) and email the owner.
 *
 * Design §19 #6: "Auto-pause on distress signals." Idempotent — once paused,
 * repeated triggers don't re-send the alert.
 */

import { getSettings, updateSettings } from "@/lib/settings";
import { sendPauseAlert } from "@/email/alerts";
import { UnipileError } from "@/unipile/client";

// A transient (rate-limit) pause auto-lifts after this cooldown. A hard pause
// (account restricted) never auto-lifts — it needs a human to look.
const AUTO_RESUME_AFTER_MINUTES = 60;

export async function isGlobalPaused(): Promise<boolean> {
  const s = await getSettings();
  return s.outreach.globalPause;
}

/** Trip the kill switch. No-op if already paused. */
export async function tripGlobalPause(reason: string, kind: "transient" | "hard" = "hard"): Promise<void> {
  const s = await getSettings();
  if (s.outreach.globalPause) return; // already paused — don't re-alert
  await updateSettings({
    outreach: { ...s.outreach, globalPause: true, pausedAt: new Date().toISOString(), pauseKind: kind },
  });
  console.error(`[safety] GLOBAL PAUSE tripped (${kind}): ${reason}`);
  await sendPauseAlert(reason).catch((e) => console.error("[safety] pause alert email failed:", e));
}

/**
 * Inspect an error thrown during a Unipile send. If it's a distress signal,
 * trip the pause and return true (caller should abort the tick). Otherwise false.
 * A 429 is transient (auto-resumes); an account restriction is hard.
 */
export async function handleSendError(err: unknown): Promise<boolean> {
  if (err instanceof UnipileError && (err.isRateLimited || err.isAccountRestricted)) {
    const kind = err.isAccountRestricted ? "hard" : "transient";
    await tripGlobalPause(`Unipile ${err.status}${err.code ? ` (${err.code})` : ""}: ${err.message}`, kind);
    return true;
  }
  return false;
}

/**
 * Auto-resume a TRANSIENT pause once its cooldown has elapsed. Hard pauses are
 * left for a human. Returns true if it just resumed. Safe to call every tick.
 */
export async function maybeAutoResume(): Promise<boolean> {
  const s = await getSettings();
  if (!s.outreach.globalPause) return false;
  if (s.outreach.pauseKind !== "transient" || !s.outreach.pausedAt) return false;
  const pausedMs = Date.parse(s.outreach.pausedAt);
  if (Number.isNaN(pausedMs)) return false;
  if (Date.now() - pausedMs < AUTO_RESUME_AFTER_MINUTES * 60 * 1000) return false;
  await updateSettings({ outreach: { ...s.outreach, globalPause: false, pausedAt: null, pauseKind: null } });
  console.log(`[safety] auto-resumed after ${AUTO_RESUME_AFTER_MINUTES}m transient-pause cooldown`);
  return true;
}
