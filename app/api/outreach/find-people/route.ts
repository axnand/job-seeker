/**
 * POST /api/outreach/find-people  { jobIds: string[], count?: number }
 *
 * Manual bulk "Find people" for the board's selection bar. For each selected job,
 * find up to `count` (default 10) LinkedIn targets it doesn't already have and
 * queue draft outreach for them (QUEUED threads, nothing sends until the owner
 * hits "Send now" or the tick runs). Tops jobs up to the target — already-found
 * contacts are excluded and count toward the total.
 *
 * Behind basic auth (middleware). Slow (LinkedIn search + AI drafting per
 * target), so give it room.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { findTargets } from "@/outreach/people-finder";
import { draftAndQueueTargets } from "@/outreach/enqueue";
import { recomputeOutreachState } from "@/status/outreach-state";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { jobIds?: string[]; count?: number };
  const jobIds = Array.isArray(body.jobIds) ? body.jobIds.filter(Boolean) : [];
  if (jobIds.length === 0) {
    return NextResponse.json({ error: "jobIds required" }, { status: 400 });
  }
  const target = Math.min(Math.max(Math.round(body.count ?? 10), 1), 20);

  const settings = await getSettings();
  const jobs = await prisma.job.findMany({ where: { id: { in: jobIds } } });

  let drafted = 0;
  let jobsTouched = 0;
  let noTargets = 0;

  for (const job of jobs) {
    if (job.appStage === "SKIPPED") continue;

    // Exclude people already targeted for this job; they count toward the target.
    const existing = await prisma.outreach.findMany({
      where: { jobId: job.id },
      select: { contact: { select: { linkedinProviderId: true } } },
    });
    const exclude = new Set(existing.map((o) => o.contact.linkedinProviderId));
    const need = target - exclude.size;
    if (need <= 0) continue;

    const targets = await findTargets(job, { max: need, exclude });
    if (targets.length === 0) {
      noTargets++;
      continue;
    }

    const n = await draftAndQueueTargets(job, targets, settings);
    if (n > 0) {
      drafted += n;
      jobsTouched++;
      await recomputeOutreachState(job.id).catch(() => {});
    }
  }

  return NextResponse.json({ ok: true, drafted, jobsTouched, noTargets });
}
