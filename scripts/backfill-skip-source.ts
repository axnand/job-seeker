/**
 * One-off backfill: populate Job.skipSource for existing SKIPPED rows that
 * predate the column. Idempotent — only touches rows where appStage=SKIPPED
 * AND skipSource IS NULL, so re-running is a no-op.
 *
 * Prints a classification summary. Pass --apply to actually write; without it
 * the script is a dry run.
 *
 * Run: tsx --env-file=.env scripts/backfill-skip-source.ts [--apply]
 *
 * Classification (there is no perfectly reliable signal for pre-column rows, so
 * we use the same prose markers the writers left, plus a timing heuristic for
 * the ambiguous manual-vs-AI-score case):
 *   • appStageNote starts "Auto-closed:"          → STALE
 *   • appStageNote starts "Company blacklisted:"  → BLACKLIST
 *   • aiReason starts "Triage (cheap-model..."    → AI_TRIAGE
 *   • scored + skipped noticeably AFTER creation  → MANUAL   (job lived on the
 *       board, then the owner skipped it — discovery auto-rejects are created
 *       and skipped in the same instant, so updatedAt≈createdAt)
 *   • everything else                             → AI_SCORE
 */
import { prisma } from "@/lib/prisma";
import type { SkipSource } from "@prisma/client";

// A discovery auto-reject is created already-SKIPPED and never touched again, so
// updatedAt is within seconds of createdAt. A manual skip is a job discovered
// earlier and skipped later. 5 min is a generous margin against clock jitter.
const MANUAL_GAP_MS = 5 * 60 * 1000;

function classify(j: {
  appStageNote: string | null;
  aiReason: string | null;
  aiScore: number | null;
  createdAt: Date;
  updatedAt: Date;
}): SkipSource {
  const note = j.appStageNote ?? "";
  if (note.startsWith("Auto-closed:")) return "STALE";
  if (note.startsWith("Company blacklisted:")) return "BLACKLIST";
  if ((j.aiReason ?? "").startsWith("Triage (cheap-model")) return "AI_TRIAGE";
  const gap = j.updatedAt.getTime() - j.createdAt.getTime();
  if (j.aiScore !== null && gap > MANUAL_GAP_MS) return "MANUAL";
  return "AI_SCORE";
}

async function main() {
  const apply = process.argv.includes("--apply");

  const rows = await prisma.job.findMany({
    where: { appStage: "SKIPPED", skipSource: null },
    select: { id: true, appStageNote: true, aiReason: true, aiScore: true, createdAt: true, updatedAt: true },
  });

  const buckets: Record<SkipSource, string[]> = {
    MANUAL: [], AI_TRIAGE: [], AI_SCORE: [], STALE: [], BLACKLIST: [],
  };
  for (const r of rows) buckets[classify(r)].push(r.id);

  console.log(`\nFound ${rows.length} SKIPPED jobs with no skipSource. Classification:`);
  for (const src of Object.keys(buckets) as SkipSource[]) {
    console.log(`  ${src.padEnd(10)} ${buckets[src].length}`);
  }

  if (!apply) {
    console.log(`\nDry run — nothing written. Re-run with --apply to persist.\n`);
    return;
  }

  let written = 0;
  for (const src of Object.keys(buckets) as SkipSource[]) {
    const ids = buckets[src];
    if (ids.length === 0) continue;
    const res = await prisma.job.updateMany({
      where: { id: { in: ids }, skipSource: null }, // guard keeps it idempotent
      data: { skipSource: src },
    });
    written += res.count;
    console.log(`  wrote skipSource=${src} to ${res.count} jobs`);
  }
  console.log(`\nBackfill complete — ${written} rows updated.\n`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
