/**
 * enqueueOutreach — called when the owner approves a job.
 *
 *  • MANUAL_NOTIFY  → email the owner the apply link + pitch; no LinkedIn outreach.
 *  • REFERRAL_FIRST → find targets, draft messages, create Contact + Outreach +
 *    ChannelThread rows that AUTO-SEND: each thread starts in the QUEUED phase
 *    (or CONNECTED for an existing 1st-degree connection) with nextActionAt=now,
 *    so the next tick claims and sends it. There is NO manual review gate — sends
 *    are still gated by the send window, the daily/weekly rate budget, and the
 *    globalPause kill switch, and the owner can fire them early with the
 *    "Send invites now" / "Send DMs now" buttons.
 *
 * Idempotent: if the job already has outreach rows, it's a no-op.
 */

import type { Job } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { config } from "@/config";
import { getSettings, type AppSettingsData } from "@/lib/settings";
import { findTargets, type OutreachTarget } from "./people-finder";
import { writeMessages } from "./message-writer";
import { sendManualNotify } from "@/email/alerts";
import { recomputeOutreachState } from "@/status/outreach-state";
import { withCronLock } from "@/lib/cron-lock";

export interface EnqueueResult {
  mode: "manual_notify" | "referral" | "noop" | "no_targets";
  targetsDrafted: number;
}

export async function enqueueOutreach(job: Job): Promise<EnqueueResult> {
  // Closed postings never start new outreach (the open sibling owns the pool).
  if (job.closedAt) return { mode: "noop", targetsDrafted: 0 };

  // Manual-apply jobs: just email the owner. No threads.
  if (job.applyType === "MANUAL_NOTIFY") {
    await sendManualNotify({
      jobId: job.id,
      company: job.company,
      role: job.role,
      applyUrl: job.applyUrl,
      tailoredPitch: job.tailoredPitch,
    }).catch((e) => console.error(`[enqueue] manual-notify email failed for ${job.id}:`, e));
    return { mode: "manual_notify", targetsDrafted: 0 };
  }

  // Idempotency + double-approve safety. The plain count check below races when a
  // job is approved twice in quick succession (two requests both read 0 and both
  // create a full set of threads → double invites). Serialize per-job enqueues
  // with the codebase's atomic single-runner lock: a concurrent second approval
  // no-ops (the first is creating the rows), and a later re-approval sees count>0.
  const locked = await withCronLock(`enqueue:${job.id}`, async (): Promise<EnqueueResult> => {
    const existing = await prisma.outreach.count({ where: { jobId: job.id } });
    if (existing > 0) return { mode: "noop", targetsDrafted: existing };

    const settings = await getSettings();

    const targets = await findTargets(job);
    if (targets.length === 0) {
      console.log(`[enqueue] job ${job.id} (${job.company}) — no outreach targets found`);
      return { mode: "no_targets", targetsDrafted: 0 };
    }

    const drafted = await draftAndQueueTargets(job, targets, settings);
    await recomputeOutreachState(job.id).catch(() => {});
    return { mode: "referral", targetsDrafted: drafted };
  });

  // Lock held by a concurrent enqueue for this same job — it will create the rows.
  if (!locked.ran) return { mode: "noop", targetsDrafted: 0 };
  return locked.result;
}

/**
 * Draft + QUEUE outreach for a set of targets (shared by initial enqueue and the
 * replenish top-up loop). For each target: write the messages, upsert the shared
 * Contact, and create an Outreach + ChannelThread in the QUEUED phase with
 * nextActionAt=now so the next tick claims and sends it (still gated by the send
 * window + rate budget + globalPause). Returns the count successfully drafted.
 *
 * Does NOT recompute outreach state — the caller does that once after the batch.
 */
export async function draftAndQueueTargets(
  job: Job,
  targets: OutreachTarget[],
  settings: AppSettingsData,
): Promise<number> {
  const followupsTotal = 1 + Math.max(0, settings.outreach.maxFollowups); // first DM + N followups

  let drafted = 0;
  for (const target of targets) {
    try {
      const messages = await writeMessages({ target, company: job.company, role: job.role, pitch: job.tailoredPitch });

      // Upsert the shared Contact (one human = one row, keyed by provider id).
      const contact = await prisma.contact.upsert({
        where: { linkedinProviderId: target.providerId },
        create: {
          linkedinProviderId: target.providerId,
          name: target.name,
          title: target.title,
          company: target.company ?? job.company,
          linkedinUrl: target.linkedinUrl,
        },
        update: {
          // Refresh display fields but DON'T touch lastContactedAt (set at send time).
          name: target.name,
          title: target.title ?? undefined,
        },
      });

      // Outreach ↔ ChannelThread are mutually @unique; create the join first
      // (threadId null), then the thread, then backfill threadId. Do all three in
      // one transaction so a crash between them can't leave a threadId-less
      // Outreach (invisible to the tick) or a thread whose outreach never points
      // back at it.
      await prisma.$transaction(async (tx) => {
        const outreach = await tx.outreach.create({
          data: { jobId: job.id, contactId: contact.id, role: target.role },
        });

        const thread = await tx.channelThread.create({
          data: {
            outreachId: outreach.id,
            status: "PENDING",
            channel: "linkedin",
            accountId: config.owner.linkedinAccountId || null,
            candidateProviderId: target.providerId,
            followupsTotal,
            // FULLY AUTOMATIC: queue now so the next tick claims + sends it
            // (still gated by send window + rate limits + globalPause).
            nextActionAt: new Date(),
            providerState: {
              // A 1st-degree connection needs no invite — start at CONNECTED so the
              // tick sends the first DM straight away (frees invite-rate budget for
              // cold targets). doSendFirstDm falls back to INVITE_PENDING if the
              // connection assumption turns out wrong ("not connected" on send).
              phase: target.isConnection ? "CONNECTED" : "QUEUED",
              // Connection note is OPTIONAL and OFF by default: an empty
              // connectionNote means the invite is sent with NO note. The drafted
              // text is kept as connectionNoteDraft so the manual bulk-send can
              // opt in ("Send with note") without regenerating it.
              connectionNote: "",
              connectionNoteDraft: messages.connectionNote,
              firstDm: messages.firstDm,
              followup: messages.followup,
            },
          },
        });

        await tx.outreach.update({
          where: { id: outreach.id },
          data: { threadId: thread.id },
        });
      });

      drafted++;
    } catch (err) {
      console.error(`[enqueue] failed to draft outreach for ${target.name} (job ${job.id}):`, err);
    }
  }

  return drafted;
}
