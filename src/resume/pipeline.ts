/**
 * Automated resume tailoring pipeline.
 *
 * tailorResumeForJob(jobId):
 *   guards → LLM edit proposal (validated, self-repairing) → apply edits →
 *   compile (external service, self-repairing on source errors) → truthfulness
 *   re-check → upload PDF to S3 → Job.tailoredResumeKey + tailorLog.
 *
 * Every outcome (success, no-edits, failure) is recorded in Job.tailorLog.
 * Failures NEVER block outreach: tailoredResumeKey stays null and the DM flow
 * falls back to the base resume PDF (thread-worker resolves key ?? base).
 */

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getSettings } from "@/lib/settings";
import { uploadResume, isS3Configured } from "@/lib/s3";
import { compileLatex, isSourceError, pdfPageCount } from "./compile";
import { proposeEdits, repairCompileError, MAX_EDITS } from "./tailor";
import { swapContactBlock } from "./alt-identity";
import { buildVocabulary, validateEdits, applyEdits, documentIntroducesClaims } from "./whitelist";

const COMPILE_REPAIR_ROUNDS = 2;
// Max tailor attempts before a TRANSIENT failure (compile service down, LLM /
// network blip) is marked permanently "failed". Deterministic failures (source
// errors that survive repair, bad PDF) are never retried. See C4 in the audit.
const MAX_TAILOR_ATTEMPTS = 4;

export interface TailorOutcome {
  status: "tailored" | "no_edits" | "skipped" | "failed";
  detail: string;
  editsApplied?: number;
}

async function tailoringProviderId(): Promise<string | undefined> {
  const p = await prisma.aiProvider.findFirst({ where: { isForTailoring: true } }).catch(() => null);
  return p?.id;
}

/** Persist the audit log regardless of outcome. */
async function logOutcome(jobId: string, log: Record<string, unknown>): Promise<void> {
  await prisma.job.update({ where: { id: jobId }, data: { tailorLog: log as Prisma.InputJsonValue } }).catch(() => {});
}

/**
 * Build the per-job ALTERNATE-identity resume: the same tailored .tex, only the
 * contact block swapped to the alt email/phone. Best-effort — a failure here
 * NEVER fails the main tailoring; the direct-application flow just falls back to
 * the static profile.altResumeKey. Returns the uploaded S3 key, or null.
 */
async function buildAltTailored(jobId: string, tailoredTex: string): Promise<string | null> {
  const { altIdentity } = await getSettings();
  if (!altIdentity.email || !altIdentity.phone) return null; // alt identity not set up

  const swapped = swapContactBlock(tailoredTex, altIdentity.email, altIdentity.phone);
  if (!swapped) return null; // no contact block found to swap

  const compiled = await compileLatex(swapped.tex);
  if (!compiled.ok) return null;
  const pages = pdfPageCount(compiled.pdf!);
  if (compiled.pdf!.length < 10_000 || (pages !== null && (pages < 1 || pages > 4))) return null;

  const key = `resume/jobs/${jobId}/alt-tailored-${Date.now()}.pdf`;
  await uploadResume(key, compiled.pdf!);
  return key;
}

export async function tailorResumeForJob(jobId: string): Promise<TailorOutcome> {
  const [job, profile] = await Promise.all([
    prisma.job.findUnique({ where: { id: jobId } }),
    prisma.resumeProfile.findUnique({ where: { id: "default" } }),
  ]);

  if (!job) return { status: "skipped", detail: "job not found" };
  if (job.tailoredResumeKey) return { status: "skipped", detail: "tailored resume already exists" };
  if (!job.needsTailoring) return { status: "skipped", detail: "job does not need tailoring" };
  if (!profile?.masterTex) return { status: "skipped", detail: "no master .tex saved — paste it on the Resume page" };
  if (!isS3Configured()) return { status: "skipped", detail: "S3 not configured" };

  const masterTex = profile.masterTex;
  // Vocabulary is cached on the profile; rebuild defensively if absent.
  const vocabulary = Array.isArray(profile.whitelist)
    ? (profile.whitelist as string[])
    : buildVocabulary(masterTex);

  // Truthfulness gate is a settings toggle (default on). Off = relaxed mode: the
  // model may add adjacent JD-relevant skills the master lacks (owner opted in).
  const { ai } = await getSettings();
  const enforceTruthfulness = ai.truthfulTailoring !== false;

  // Prior transient-failure count (C4): infra/LLM blips are logged as
  // "failed_retryable" with an attempt counter and re-swept up to MAX_TAILOR_ATTEMPTS.
  const prevAttempts = (job.tailorLog as { attempts?: number } | null)?.attempts ?? 0;

  const startedAt = new Date().toISOString();
  const providerId = await tailoringProviderId();

  try {
    // 1. Propose + validate surgical edits.
    const proposal = await proposeEdits({
      masterTex,
      vocabulary,
      company: job.company,
      role: job.role,
      jdText: job.jdText,
      tailoringSuggestions: job.tailoringSuggestions,
      providerId,
      enforceTruthfulness,
    });

    if (proposal.edits.length === 0) {
      const detail = proposal.rejected.length > 0
        ? "all proposed edits were rejected by the truthfulness validator"
        : "model found no edits worth making";
      await logOutcome(jobId, { status: "no_edits", detail, rejected: proposal.rejected, startedAt });
      return { status: "no_edits", detail };
    }

    // Defense in depth: re-validate right before applying.
    const lastCheck = validateEdits(proposal.edits, masterTex, vocabulary, MAX_EDITS, { enforceTruthfulness });
    if (lastCheck.length > 0) {
      await logOutcome(jobId, { status: "failed", detail: "post-repair validation failed", violations: lastCheck, startedAt });
      return { status: "failed", detail: "post-repair validation failed" };
    }

    // 2. Apply and compile, self-repairing on source errors.
    let tex = applyEdits(masterTex, proposal.edits);
    let compiled = await compileLatex(tex);
    let repairs = 0;

    while (!compiled.ok && isSourceError(compiled) && repairs < COMPILE_REPAIR_ROUNDS) {
      repairs++;
      const fixed = await repairCompileError(tex, compiled.log, providerId);
      if (!fixed) break;
      // The repair rewrites the whole document — in strict mode make sure it
      // didn't invent facts (skipped in relaxed mode, where new claims are allowed).
      if (enforceTruthfulness) {
        const smuggled = documentIntroducesClaims(fixed, vocabulary);
        if (smuggled.length > 0) {
          compiled = { ...compiled, log: `repair rejected — introduced new claims: ${smuggled.slice(0, 5).join(", ")}` };
          break;
        }
      }
      tex = fixed;
      compiled = await compileLatex(tex);
    }

    if (!compiled.ok) {
      // Distinguish a TRANSIENT infra failure (compile service unreachable) from a
      // deterministic SOURCE error the repair loop couldn't fix. Only infra
      // failures are retryable — otherwise a 10-min outage would strand the job on
      // the base resume forever (the sweep re-selects "failed_retryable").
      const infra = !isSourceError(compiled);
      const attempts = prevAttempts + 1;
      const retryable = infra && attempts < MAX_TAILOR_ATTEMPTS;
      await logOutcome(jobId, {
        status: retryable ? "failed_retryable" : "failed",
        attempts,
        detail: infra
          ? "compile service unreachable — will retry"
          : "compilation failed — outreach will use the base resume",
        compileLog: compiled.log.slice(-1500),
        compileProvider: compiled.provider,
        repairs,
        edits: proposal.edits,
        startedAt,
      });
      return { status: "failed", detail: `compile failed after ${repairs} repair(s)${retryable ? " (retryable)" : ""}` };
    }

    // Output sanity: pdflatex recovers from many errors and still emits a PDF,
    // so "compiled" alone can ship a mangled resume. A real one-page resume is
    // >10KB with 1-4 pages; outside that, don't attach it to outreach.
    const pages = pdfPageCount(compiled.pdf!);
    if (compiled.pdf!.length < 10_000 || (pages !== null && (pages < 1 || pages > 4))) {
      await logOutcome(jobId, {
        status: "failed",
        detail: `compiled PDF failed sanity check (${compiled.pdf!.length} bytes, ${pages ?? "?"} pages) — outreach will use the base resume`,
        edits: proposal.edits,
        startedAt,
      });
      return { status: "failed", detail: "compiled PDF failed sanity check" };
    }

    // 3. Upload + persist. Build the alt-identity variant from the SAME tailored
    //    source so the direct application is tailored too (best-effort).
    const key = `resume/jobs/${jobId}/tailored-${Date.now()}.pdf`;
    await uploadResume(key, compiled.pdf!);
    const altKey = await buildAltTailored(jobId, tex).catch(() => null);
    await prisma.job.update({
      where: { id: jobId },
      data: {
        tailoredResumeKey: key,
        altTailoredResumeKey: altKey,
        tailorLog: {
          status: "tailored",
          edits: proposal.edits,
          rejected: proposal.rejected,
          repairs,
          compileProvider: compiled.provider,
          altTailored: !!altKey, // alt-identity variant produced from the same edits
          startedAt,
          finishedAt: new Date().toISOString(),
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return { status: "tailored", detail: `${proposal.edits.length} edit(s), ${repairs} repair round(s)`, editsApplied: proposal.edits.length };
  } catch (err) {
    const detail = (err as Error).message;
    // Errors here (LLM/network/S3) are usually transient — mark retryable up to
    // MAX so a blip doesn't permanently strand the job on the base resume.
    const attempts = prevAttempts + 1;
    const retryable = attempts < MAX_TAILOR_ATTEMPTS;
    await logOutcome(jobId, { status: retryable ? "failed_retryable" : "failed", attempts, detail, startedAt });
    return { status: "failed", detail };
  }
}

/**
 * Catch-up sweep: tailor approved jobs that still lack a tailored PDF.
 * Called from the outreach-tick cron so crashes/limits never strand a job.
 * Small batch per tick — tailoring is LLM+compile heavy.
 */
export async function sweepPendingTailoring(batchSize = 2): Promise<number> {
  // Both gates, not just masterTex: with S3 unconfigured every job "skips"
  // without a tailorLog entry, so the same batch would re-select every sweep.
  if (!isS3Configured()) return 0;
  const profile = await prisma.resumeProfile.findUnique({ where: { id: "default" } }).catch(() => null);
  if (!profile?.masterTex) return 0; // feature not enabled yet

  const pending = await prisma.job.findMany({
    where: {
      appStage: "APPROVED",
      needsTailoring: true,
      tailoredResumeKey: null,
      closedAt: null,
      // Never attempted (null) OR a TRANSIENT failure flagged for retry. A
      // permanent "failed" (source error / bad PDF / retries exhausted) is NOT
      // re-selected. The attempt cap is enforced at write time, so a retryable
      // job flips to "failed" once it hits MAX_TAILOR_ATTEMPTS and drops out here.
      OR: [
        { tailorLog: { equals: Prisma.AnyNull } },
        { tailorLog: { path: ["status"], equals: "failed_retryable" } },
      ],
    },
    orderBy: { discoveredAt: "desc" },
    take: batchSize,
    select: { id: true, company: true, role: true },
  });

  let done = 0;
  for (const job of pending) {
    const outcome = await tailorResumeForJob(job.id);
    console.log(`[tailor-sweep] ${job.company} / ${job.role}: ${outcome.status} — ${outcome.detail}`);
    if (outcome.status === "tailored") done++;
  }
  return done;
}
