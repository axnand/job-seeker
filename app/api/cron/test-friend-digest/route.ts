/**
 * GET /api/cron/test-friend-digest
 * Manual trigger to test the friend digest pipeline end-to-end.
 * Accepts optional ?to=email to override the recipient (for previewing).
 * Protected by the same Bearer CRON_SECRET as other cron routes.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendFriendDigest } from "@/email/friend-digest";

export async function GET(req: NextRequest) {
  try {
    const overrideTo = req.nextUrl.searchParams.get("to") ?? undefined;

    const jobs = await prisma.job.findMany({
      where: { appStage: { in: ["NEW", "APPROVED"] } },
      orderBy: { discoveredAt: "desc" },
      take: 50,
    });

    const salaryBreakdown = {
      total: jobs.length,
      withSalary: jobs.filter(j => j.salaryAnnualBase !== null).length,
      nullSalary: jobs.filter(j => j.salaryAnnualBase === null).length,
      above8LPA: jobs.filter(j => j.salaryAnnualBase === null || (j.salaryAnnualBase ?? 0) >= 800_000).length,
      confirmedBelow8LPA: jobs.filter(j => j.salaryAnnualBase !== null && j.salaryAnnualBase < 800_000).length,
    };

    if (salaryBreakdown.above8LPA === 0) {
      return NextResponse.json({ ok: false, reason: "no eligible jobs found", salaryBreakdown });
    }

    await sendFriendDigest(jobs, overrideTo);

    return NextResponse.json({
      ok: true,
      emailSentTo: overrideTo ?? "mmayank.connect@gmail.com",
      salaryBreakdown,
    });
  } catch (err) {
    console.error("[test-friend-digest]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
