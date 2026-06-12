/**
 * Builds the LinkedIn outreach messages for one target by filling the owner's
 * editable templates (Settings → Outreach). Deterministic — the exact template
 * you set is what sends. Placeholders: {firstName} {name} {company} {role} {pitch}
 *
 * Produces a connection note (≤300 chars, sent WITH the invite), a first DM
 * (sent after acceptance), and one follow-up.
 */

import { config } from "@/config";
import { getSettings } from "@/lib/settings";
import { sanitizePitch } from "@/scoring/ai-scorer";
import type { OutreachTarget } from "./people-finder";

export interface OutreachMessages {
  connectionNote: string;
  firstDm: string;
  followup: string;
}

function fill(tpl: string, vars: Record<string, string>): string {
  return tpl
    .replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "")
    .replace(/[^\S\n]*[—–][^\S\n]*/g, ", ") // em/en dash → comma (DB-overridden templates can still contain them)
    .replace(/[^\S\n]+/g, " ")   // collapse horizontal whitespace only (preserve newlines)
    .replace(/ *\n */g, "\n")    // trim spaces around newlines
    .trim();
}

/**
 * Clean a job role for human-readable use in messages.
 * Job boards add formatting noise: "SDE ; Backend", "Software Engineer | Remote", "Dev (Full-Stack)".
 * Strip separators and parentheticals, take the first meaningful segment.
 */
function cleanRole(role: string): string {
  return role
    .replace(/\s*[;|–—\-]\s*(?:remote|hybrid|on.?site|full.?time|part.?time|contract|backend|frontend|full.?stack).*/gi, "") // strip noise suffixes
    .replace(/\s*[;|–—]\s*.*/g, "")   // strip everything after ; | – —
    .replace(/\s*\(.*?\)\s*/g, " ")   // strip parentheticals
    .replace(/\s+/g, " ")
    .trim();
}

export async function writeMessages(opts: {
  target: OutreachTarget;
  company: string;
  role: string;
  pitch: string;
  resumeUrl?: string;
  jobId?: string;
}): Promise<OutreachMessages> {
  const settings = await getSettings().catch(() => null);
  const templates = settings?.templates ?? config.templates;

  const firstName = opts.target.name.split(" ")[0] || opts.target.name;
  const role = cleanRole(opts.role);
  const vars: Record<string, string> = {
    firstName,
    name: opts.target.name,
    company: opts.company,
    role,
    pitch: opts.pitch ? sanitizePitch(opts.pitch) : "",
    ownerName: config.owner.name || "",
    ownerFirstName: (config.owner.name || "").split(" ")[0] || "",
    resumeLink: opts.resumeUrl ? `My resume: ${opts.resumeUrl}` : "",
    // {jobId} = raw id (or empty). {jobRef} = a ready-made clause that disappears
    // when there's no id, so the template reads cleanly either way.
    jobId: opts.jobId ?? "",
    jobRef: opts.jobId ? ` The job ID is ${opts.jobId}, in case it helps with the referral.` : "",
  };

  return {
    connectionNote: fill(templates.connectionNote, vars).slice(0, 300),
    firstDm:        fill(templates.firstDm, vars),
    followup:       fill(templates.followup, vars),
  };
}
