/**
 * POST /api/companies/unblacklist
 * Body: { company: string, restores?: Array<{ id: string; stage: string }> }
 *
 * Undo a blacklist action: removes the company from the setting and restores
 * specified jobs to their pre-blacklist stages. Used by the toast "Undo" button.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSettings, updateSettings } from "@/lib/settings";
import type { AppStage } from "@prisma/client";

const VALID: AppStage[] = ["NEW", "APPROVED", "OUTREACH", "REPLIED", "APPLIED", "INTERVIEWING", "OFFER", "SKIPPED"];

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    company?: string;
    restores?: Array<{ id: string; stage: string }>;
  };

  const company = body.company?.trim();
  if (!company) {
    return NextResponse.json({ error: "company required" }, { status: 400 });
  }

  // Remove from blacklist (case-insensitive match).
  const settings = await getSettings();
  const termLower = company.toLowerCase();
  const updated = settings.search.blacklistedCompanies.filter(
    (c) => c.toLowerCase() !== termLower,
  );
  if (updated.length !== settings.search.blacklistedCompanies.length) {
    await updateSettings({ search: { ...settings.search, blacklistedCompanies: updated } });
  }

  // Restore jobs to their previous stages.
  let restored = 0;
  for (const r of body.restores ?? []) {
    const stage = r.stage?.toUpperCase() as AppStage;
    if (!r.id || !VALID.includes(stage)) continue;
    await prisma.job.updateMany({
      where: { id: r.id },
      data: { appStage: stage, appStageNote: null },
    });
    restored++;
  }

  return NextResponse.json({ ok: true, removed: company, restored });
}
