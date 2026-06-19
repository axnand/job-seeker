/**
 * Builds the LinkedIn outreach messages for one target by filling the owner's
 * editable templates (Settings → Outreach). Deterministic — the exact template
 * you set is what sends. Placeholders: {firstName} {company} {role} {ownerName}
 *
 * Produces a connection note (≤300 chars, sent WITH the invite), a first DM
 * (sent after acceptance), and one follow-up.
 *
 * renderMessages() is called at SEND TIME (in thread-worker) so template changes
 * take effect on all queued threads immediately — not just new ones.
 */

import { config } from "@/config";
import { getSettings } from "@/lib/settings";
import type { OutreachTarget } from "./people-finder";

export interface OutreachMessages {
  connectionNote: string;
  firstDm: string;
  followup: string;
}

export function fill(tpl: string, vars: Record<string, string>): string {
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

/**
 * Render all three messages from name + company + role using the current template.
 * Called at send time so template edits take effect on already-queued threads.
 */
export async function renderMessages(opts: {
  name: string;
  company: string;
  role: string;
}): Promise<OutreachMessages> {
  const settings = await getSettings().catch(() => null);
  const templates = settings?.templates ?? config.templates;

  const firstName = opts.name.split(" ")[0] || opts.name;
  const role = cleanRole(opts.role);
  const vars: Record<string, string> = {
    firstName,
    name: opts.name,
    company: opts.company,
    role,
    ownerName: config.owner.name || "",
    ownerFirstName: (config.owner.name || "").split(" ")[0] || "",
  };

  return {
    connectionNote: fill(templates.connectionNote, vars).slice(0, 300),
    firstDm:        fill(templates.firstDm, vars),
    followup:       fill(templates.followup, vars),
  };
}

/** Used only at enqueue time to draft the connection note for the review UI. */
export async function writeMessages(opts: {
  target: OutreachTarget;
  company: string;
  role: string;
}): Promise<OutreachMessages> {
  return renderMessages({ name: opts.target.name, company: opts.company, role: opts.role });
}
