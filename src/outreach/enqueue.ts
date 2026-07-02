/**
 * enqueueOutreach — called when the owner approves a job.
 *
 *  • MANUAL_NOTIFY  → email the owner the apply link + pitch; no LinkedIn outreach.
 *  • REFERRAL_FIRST → find targets, draft messages, create Contact + Outreach +
 *    ChannelThread rows in the DRAFT phase. NOTHING SENDS YET — the threads sit
 *    with nextActionAt=null so the tick never claims them. The owner reviews and
 *    edits the messages in the drawer, then "Confirm & Send" queues them (sets
 *    phase=QUEUED, nextActionAt=now). This is the "never blind-send" promise.
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

  // Idempotency — already enqueued?
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
      // (threadId null), then the thread, then backfill threadId.
      const outreach = await prisma.outreach.create({
        data: { jobId: job.id, contactId: contact.id, role: target.role },
      });

      const thread = await prisma.channelThread.create({
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
            phase: "QUEUED",
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

      await prisma.outreach.update({
        where: { id: outreach.id },
        data: { threadId: thread.id },
      });

      drafted++;
    } catch (err) {
      console.error(`[enqueue] failed to draft outreach for ${target.name} (job ${job.id}):`, err);
    }
  }

  return drafted;
}
