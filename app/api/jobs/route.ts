import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { AppStage } from "@prisma/client";

/** GET /api/jobs?appStage=NEW&source=LINKEDIN_JOB&limit=50&cursor=<id> */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const appStage = sp.get("appStage") as AppStage | null;
  const source = sp.get("source");
  const limit = Math.min(Number(sp.get("limit") ?? 50), 200);
  const cursor = sp.get("cursor");

  const jobs = await prisma.job.findMany({
    where: {
      ...(appStage ? { appStage } : { appStage: { not: "SKIPPED" } }),
      ...(source ? { source: source as never } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      outreaches: { include: { contact: true } },
    },
  });

  const nextCursor = jobs.length === limit ? jobs[jobs.length - 1].id : null;
  return NextResponse.json({ jobs, nextCursor });
}
