/**
 * Replenish loop — keep each job's connection-invite pipeline full until we reach
 * the accept target, exhaust the company's candidate pool, or hit the per-job
 * invite ceiling.
 *
 * The problem it solves: we invite ~maxReferralTargetsPerJob people, but only a
 * fraction ACCEPT. Without replenishment a job that gets 2 of 10 accepts just
 * stalls at 2. This loop notices the open slots and tops them up with fresh
 * people from the same company.
 *
 * Runs every tick but is cheap: only jobs past their per-job backoff window are
 * examined (lastReplenishAt), and LinkedIn people-search only fires when a job
 * actually has an open slot. It ONLY drafts + QUEUEs new threads — actual sends
 * stay gated by the send window, rate budget, and globalPause in the claim loop.
 *
 * Per job, threads are tallied into:
 *   accepted — phase CONNECTED|MESSAGED, or status REPLIED (they said yes)
 *   pending  — a live invite occupying a slot (QUEUED not-yet-sent or INVITE_PENDING)
 *   total    — every thread ever created (counts toward the invite ceiling)
 * Then we fill `pending` up to maxReferralTargetsPerJob, bounded by the ceiling.
 *
 * Stop conditions (per job): someone replied (a conversation started), accepted
 * >= connectTarget, total >= maxInvitesPerJob, or no fresh candidates remain.
 */

import { prisma } from "@/lib/prisma";
import { config } from "@/config";
import { getSettings, type AppSettingsData } from "@/lib/settings";
import { findTargets } from "./people-finder";
import { draftAndQueueTargets } from "./enqueue";
import { recomputeOutreachState } from "@/status/outreach-state";
import { sendPoolExhaustedAlert } from "@/email/alerts";

// Bound the work (DB + LinkedIn API) per tick. Oldest-attempted jobs go first,
// so over successive ticks every eligible job is serviced fairly.
const MAX_JOBS_PER_TICK = 10;

// A thread in one of these phases means the person accepted the invite.
const ACCEPTED_PHASES = new Set(["CONNECTED", "MESSAGED"]);

export interface ReplenishResult {
  examined: number;  // jobs looked at this tick
  toppedUp: number;  // jobs that got fresh threads queued
  queued: number;    // total fresh threads queued
  exhausted: number; // jobs that hit the ceiling or ran out of candidates
}

export async function replenishOutreach(settings?: AppSettingsData): Promise<ReplenishResult> {
  const res: ReplenishResult = { examined: 0, toppedUp: 0, queued: 0, exhausted: 0 };
  if (!config.owner.linkedinAccountId) return res;

  const s = settings ?? (await getSettings());
  if (s.outreach.globalPause) return res;

  const connectTarget = s.outreach.connectTarget;
  const inflightBatch = s.outreach.maxReferralTargetsPerJob;
  const maxInvites = s.outreach.maxInvitesPerJob;
  const backoffCutoff = new Date(Date.now() - s.outreach.replenishIntervalHours * 60 * 60 * 1000);

  const jobs = await prisma.job.findMany({
    where: {
      applyType: "REFERRAL_FIRST",
      appStage: { in: ["APPROVED", "OUTREACH"] },
      outreaches: { some: {} },
      OR: [{ lastReplenishAt: null }, { lastReplenishAt: { lt: backoffCutoff } }],
    },
    orderBy: { lastReplenishAt: { sort: "asc", nulls: "first" } },
    take: MAX_JOBS_PER_TICK,
  });

  for (const job of jobs) {
    res.examined++;
    // Stamp the attempt up front: this backs the job off for replenishIntervalHours
    // even if it has no gap (don't re-query) or we crash mid-loop.
    await prisma.job
      .update({ where: { id: job.id }, data: { lastReplenishAt: new Date() } })
      .catch(() => {});

    const outreaches = await prisma.outreach.findMany({
      where: { jobId: job.id },
      include: {
        thread: { select: { status: true, providerState: true, candidateProviderId: true } },
        contact: { select: { linkedinProviderId: true } },
      },
    });

    let accepted = 0;
    let pending = 0;
    let total = 0;
    let replied = false;
    const exclude = new Set<string>();

    for (const o of outreaches) {
      if (o.contact?.linkedinProviderId) exclude.add(o.contact.linkedinProviderId);
      const t = o.thread;
      if (!t) continue;
      if (t.candidateProviderId) exclude.add(t.candidateProviderId);
      total++;

      const phase = (t.providerState as { phase?: string } | null)?.phase;
      if (t.status === "REPLIED") {
        replied = true;
        accepted++;
      } else if (phase && ACCEPTED_PHASES.has(phase)) {
        accepted++;
      } else if (t.status === "PENDING" || t.status === "ACTIVE") {
        // QUEUED (not yet sent) or INVITE_PENDING — occupies an in-flight slot.
        pending++;
      }
      // ARCHIVED invites (timed out / cancelled) count toward `total` only —
      // they free their slot, which is exactly what triggers a top-up.
    }

    if (replied) continue;                                  // conversation started — stop
    if (accepted >= connectTarget) continue;                // goal reached
    if (total >= maxInvites) {                              // ceiling hit — alert once
      res.exhausted++;
      if (!job.poolAlertedAt) {
        await prisma.job.update({ where: { id: job.id }, data: { poolAlertedAt: new Date() } }).catch(() => {});
        sendPoolExhaustedAlert({
          jobId: job.id, company: job.company, role: job.role,
          accepted, connectTarget, totalSent: total, maxInvites, reason: "ceiling",
        }).catch((e) => console.error("[replenish] exhaustion alert email failed:", e));
      }
      continue;
    }

    const desired = Math.min(inflightBatch, maxInvites - total);
    const gap = desired - pending;
    if (gap <= 0) continue;                                 // pipeline already full

    const fresh = await findTargets(job, { exclude, max: gap });
    if (fresh.length === 0) {
      res.exhausted++;
      console.log(
        `[replenish] ${job.company} (${job.role}): need ${gap} more but no fresh candidates ` +
          `(accepted ${accepted}/${connectTarget}, sent ${total}/${maxInvites})`,
      );
      if (!job.poolAlertedAt) {
        await prisma.job.update({ where: { id: job.id }, data: { poolAlertedAt: new Date() } }).catch(() => {});
        sendPoolExhaustedAlert({
          jobId: job.id, company: job.company, role: job.role,
          accepted, connectTarget, totalSent: total, maxInvites, reason: "no_candidates",
        }).catch((e) => console.error("[replenish] exhaustion alert email failed:", e));
      }
      continue;
    }

    const n = await draftAndQueueTargets(job, fresh, s);
    if (n > 0) {
      res.toppedUp++;
      res.queued += n;
      await recomputeOutreachState(job.id).catch(() => {});
      console.log(
        `[replenish] ${job.company} (${job.role}): queued ${n} more ` +
          `(accepted ${accepted}/${connectTarget}, pending ${pending}→${pending + n}, sent ${total}→${total + n}/${maxInvites})`,
      );
    }
  }

  return res;
}
