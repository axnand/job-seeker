/**
 * POST /api/companies/blacklist
 * Body: { company: string }
 *
 * Adds a company to search.blacklistedCompanies (so it's filtered out of future
 * discovery and any open threads get archived on the next tick) AND skips every
 * job already on the board for that company so it disappears now.
 *
 * Matching mirrors the discover/thread-worker rule: a job matches if its company
 * (lowercased) and the blacklisted term contain each other in either direction.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSettings, updateSettings } from "@/lib/settings";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { company?: string };
  const company = body.company?.trim();
  if (!company) {
    return NextResponse.json({ error: "company required" }, { status: 400 });
  }
  const termLower = company.toLowerCase();

  // Add to the blacklist (case-insensitive dedup).
  const settings = await getSettings();
  const already = settings.search.blacklistedCompanies.some(
    (c) => c.toLowerCase() === termLower,
  );
  if (!already) {
    await updateSettings({
      search: {
        ...settings.search,
        blacklistedCompanies: [...settings.search.blacklistedCompanies, company],
      },
    });
  }

  // Skip every job already on the board for that company. Filter in JS so the
  // match uses the same bidirectional-substring rule as the rest of the app.
  const open = await prisma.job.findMany({
    where: { appStage: { not: "SKIPPED" } },
    select: { id: true, company: true },
  });
  const matchIds = open
    .filter((j) => {
      const co = j.company.toLowerCase();
      return co.includes(termLower) || termLower.includes(co);
    })
    .map((j) => j.id);

  let archived = 0;
  if (matchIds.length > 0) {
    await prisma.job.updateMany({
      where: { id: { in: matchIds } },
      data: { appStage: "SKIPPED", appStageNote: `Company blacklisted: ${company}` },
    });

    // Stop any outreach already in flight for those jobs now, rather than
    // waiting for the next tick (matters when blacklisting an approved job).
    // Replied threads are wins — leave them be.
    const threads = await prisma.channelThread.findMany({
      where: { status: { notIn: ["ARCHIVED", "REPLIED"] }, outreach: { jobId: { in: matchIds } } },
      select: { id: true },
    });
    if (threads.length > 0) {
      const res = await prisma.channelThread.updateMany({
        where: { id: { in: threads.map((t) => t.id) } },
        data: {
          status: "ARCHIVED",
          archivedAt: new Date(),
          archivedReason: `Company blacklisted: ${company}`,
          nextActionAt: null,
        },
      });
      archived = res.count;
    }
  }

  return NextResponse.json({ ok: true, blacklisted: company, skipped: matchIds.length, archived });
}
