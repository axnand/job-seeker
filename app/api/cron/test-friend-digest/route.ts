/**
 * GET /api/cron/test-friend-digest
 * Manual trigger to test the friend digest pipeline end-to-end.
 * Accepts optional ?to=email and ?minLPA=8 to override the recipient (for previewing).
 * Protected by the same Bearer CRON_SECRET as other cron routes.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendFriendDigest, type FriendRecipient } from "@/email/friend-digest";
import { config } from "@/config";

export async function GET(req: NextRequest) {
  try {
    const overrideTo = req.nextUrl.searchParams.get("to");
    const minLPA = Number(req.nextUrl.searchParams.get("minLPA") || 8);

    // Approximates the live friend pool: owner-passing jobs plus skipped jobs
    // with a confirmed salary. skipCategory isn't persisted, so unlike the live
    // run this can't exclude seniority/location skips — preview may over-include.
    const jobs = await prisma.job.findMany({
      where: {
        OR: [
          { appStage: { in: ["NEW", "APPROVED"] } },
          { appStage: "SKIPPED", salaryAnnualBase: { not: null } },
        ],
      },
      orderBy: { discoveredAt: "desc" },
      take: 50,
    });

    const minAnnualBase = minLPA * 100_000;
    const salaryBreakdown = {
      total: jobs.length,
      withSalary: jobs.filter(j => j.salaryAnnualBase !== null).length,
      nullSalary: jobs.filter(j => j.salaryAnnualBase === null).length,
      eligible: jobs.filter(j => j.salaryAnnualBase === null || (j.salaryAnnualBase ?? 0) >= minAnnualBase).length,
      confirmedBelowFloor: jobs.filter(j => j.salaryAnnualBase !== null && j.salaryAnnualBase < minAnnualBase).length,
    };

    if (salaryBreakdown.eligible === 0) {
      return NextResponse.json({ ok: false, reason: "no eligible jobs found", minLPA, salaryBreakdown });
    }

    const recipients: FriendRecipient[] = overrideTo
      ? [{ email: overrideTo, minBaseLPA: minLPA }]
      : config.friendDigest.recipients;

    await Promise.all(recipients.map(r => sendFriendDigest(jobs, r)));

    return NextResponse.json({
      ok: true,
      emailSentTo: recipients.map(r => r.email),
      minLPA,
      salaryBreakdown,
    });
  } catch (err) {
    console.error("[test-friend-digest]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
