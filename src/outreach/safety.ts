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

export async function isGlobalPaused(): Promise<boolean> {
  const s = await getSettings();
  return s.outreach.globalPause;
}

/** Trip the kill switch. No-op if already paused. */
export async function tripGlobalPause(reason: string): Promise<void> {
  const s = await getSettings();
  if (s.outreach.globalPause) return; // already paused — don't re-alert
  await updateSettings({ outreach: { ...s.outreach, globalPause: true } });
  console.error(`[safety] GLOBAL PAUSE tripped: ${reason}`);
  await sendPauseAlert(reason).catch((e) => console.error("[safety] pause alert email failed:", e));
}

/**
 * Inspect an error thrown during a Unipile send. If it's a distress signal,
 * trip the pause and return true (caller should abort the tick). Otherwise false.
 */
export async function handleSendError(err: unknown): Promise<boolean> {
  if (err instanceof UnipileError && (err.isRateLimited || err.isAccountRestricted)) {
    await tripGlobalPause(
      `Unipile ${err.status}${err.code ? ` (${err.code})` : ""}: ${err.message}`
    );
    return true;
  }
  return false;
}
