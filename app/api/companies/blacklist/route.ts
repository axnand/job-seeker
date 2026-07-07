/**
 * POST /api/companies/blacklist
 * Body: { company: string } | { companies: string[] }
 *
 * Adds the company/companies to search.blacklistedCompanies (so they're filtered
 * out of future discovery) AND, for every job already on the board that matches,
 * skips the job and archives any in-flight outreach immediately — so nothing more
 * sends for that company from now on.
 *
 * Matching mirrors the discover/thread-worker rule: a job matches a term if its
 * company (lowercased) and the term contain each other in either direction.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSettings, updateSettings } from "@/lib/settings";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { company?: string; companies?: string[] };

  // Normalise to a deduped (case-insensitive) list of non-empty terms.
  const raw = [body.company, ...(body.companies ?? [])];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const r of raw) {
    const t = r?.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(t);
  }
  if (terms.length === 0) {
    return NextResponse.json({ error: "company required" }, { status: 400 });
  }
  const termsLower = terms.map((t) => t.toLowerCase());

  // Add to the blacklist (case-insensitive dedup against what's already there).
  const settings = await getSettings();
  const existing = new Set(settings.search.blacklistedCompanies.map((c) => c.toLowerCase()));
  const toAdd = terms.filter((t) => !existing.has(t.toLowerCase()));
  if (toAdd.length > 0) {
    await updateSettings({
      search: {
        ...settings.search,
        blacklistedCompanies: [...settings.search.blacklistedCompanies, ...toAdd],
      },
    });
  }

  // Skip every job already on the board that matches any term. Filter in JS so
  // the match uses the same bidirectional-substring rule as the rest of the app.
  const open = await prisma.job.findMany({
    where: { appStage: { not: "SKIPPED" } },
    select: { id: true, company: true },
  });
  const matchIds = open
    .filter((j) => {
      const co = j.company.toLowerCase();
      return termsLower.some((t) => co.includes(t) || t.includes(co));
    })
    .map((j) => j.id);

  const reason = `Company blacklisted: ${terms.join(", ")}`;
  let archived = 0;
  if (matchIds.length > 0) {
    await prisma.job.updateMany({
      where: { id: { in: matchIds } },
      data: { appStage: "SKIPPED", appStageNote: reason, skipSource: "BLACKLIST" },
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
          archivedReason: reason,
          nextActionAt: null,
        },
      });
      archived = res.count;
    }
  }

  return NextResponse.json({ ok: true, blacklisted: terms, skipped: matchIds.length, archived });
}
