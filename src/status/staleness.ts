/**
 * Staleness auto-archive (design §20 / backlog #23).
 * Soft-closes jobs that have gone nowhere after `archiveAfterDays`:
 *   • NEW jobs the owner never reviewed (discovered too long ago)
 *   • APPROVED jobs with no live outreach (no targets / invites never accepted)
 *
 * Never closes jobs with active or successful outreach (INVITE_SENT / CONNECTED /
 * MESSAGED / REPLIED) or anything already past NEW/APPROVED. Append-only spirit:
 * sets appStage=SKIPPED with a note — no hard deletes.
 *
 * The two updateMany queries below are exact-match on NEW / APPROVED, so the
 * post-referral pipeline stages (REPLIED / APPLIED / INTERVIEWING / OFFER) are
 * structurally excluded — a job the owner has moved forward is never swept.
 */

import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export async function sweepStaleJobs(): Promise<{ closedNew: number; closedApproved: number }> {
  const settings = await getSettings();
  const cutoff = new Date(Date.now() - settings.staleness.archiveAfterDays * 24 * 60 * 60 * 1000);

  // NEW jobs the owner never acted on.
  const closedNew = await prisma.job.updateMany({
    where: { appStage: "NEW", discoveredAt: { lt: cutoff } },
    data: {
      appStage: "SKIPPED",
      appStageNote: `Auto-closed: not reviewed within ${settings.staleness.archiveAfterDays} days`,
      skipSource: "STALE",
    },
  });

  // APPROVED jobs where outreach never got traction.
  const closedApproved = await prisma.job.updateMany({
    where: {
      appStage: "APPROVED",
      approvedAt: { lt: cutoff },
      outreachState: { in: ["NONE", "NO_REPLY_ARCHIVED"] },
    },
    data: {
      appStage: "SKIPPED",
      appStageNote: `Auto-closed: no active outreach within ${settings.staleness.archiveAfterDays} days`,
      skipSource: "STALE",
    },
  });

  if (closedNew.count || closedApproved.count) {
    console.log(`[staleness] closed ${closedNew.count} stale NEW + ${closedApproved.count} stale APPROVED jobs`);
  }
  return { closedNew: closedNew.count, closedApproved: closedApproved.count };
}
