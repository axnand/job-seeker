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
import type { OutreachTarget } from "./people-finder";

export interface OutreachMessages {
  connectionNote: string;
  firstDm: string;
  followup: string;
}

function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "").replace(/\s+/g, " ").trim();
}

export async function writeMessages(opts: {
  target: OutreachTarget;
  company: string;
  role: string;
  pitch: string;
}): Promise<OutreachMessages> {
  const settings = await getSettings().catch(() => null);
  const templates = settings?.templates ?? config.templates;

  const firstName = opts.target.name.split(" ")[0] || opts.target.name;
  const vars: Record<string, string> = {
    firstName,
    name: opts.target.name,
    company: opts.company,
    role: opts.role,
    pitch: opts.pitch,
    ownerName: config.owner.name || "",
    ownerFirstName: (config.owner.name || "").split(" ")[0] || "",
  };

  return {
    connectionNote: fill(templates.connectionNote, vars).slice(0, 300),
    firstDm:        fill(templates.firstDm, vars),
    followup:       fill(templates.followup, vars),
  };
}
