import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { AppStage } from "@prisma/client";

type ProviderStateJson = { phase?: string } | null;

function computeOutreachCounts(
  threads: Array<{ status: string; providerState: unknown }>,
): { sent: number; connected: number; replied: number } {
  let sent = 0, connected = 0, replied = 0;
  for (const t of threads) {
    if (t.status === "ARCHIVED") continue;
    if (t.status === "REPLIED") { replied++; connected++; sent++; continue; }
    const phase = (t.providerState as ProviderStateJson)?.phase;
    if (phase === "MESSAGED")       { connected++; sent++; }
    else if (phase === "CONNECTED") { connected++; sent++; }
    else if (phase === "INVITE_PENDING") { sent++; }
  }
  return { sent, connected, replied };
}

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
    // Select only what the board needs. Thread data is aggregated into
    // outreachCounts server-side so the client never receives providerState JSON.
    include: {
      outreaches: {
        select: {
          thread: { select: { status: true, providerState: true } },
        },
      },
    },
  });

  const nextCursor = jobs.length === limit ? jobs[jobs.length - 1].id : null;

  const result = jobs.map(({ outreaches, ...job }) => ({
    ...job,
    outreachCounts: computeOutreachCounts(
      outreaches.map((o) => o.thread).filter((t): t is NonNullable<typeof t> => !!t),
    ),
  }));

  return NextResponse.json({ jobs: result, nextCursor });
}
