/**
 * Writes the LinkedIn outreach messages for one target, from the job's tailored
 * pitch + the target's profile. Templates follow design §7 (referral vs recruiter).
 *
 * Produces a connection note (≤300 chars, sent WITH the invite) and a first DM
 * (sent after the invite is accepted) and one follow-up. The owner reviews and
 * can edit all of these before anything sends ("never blind-send").
 */

import { chatCompletion, parseJsonResponse } from "@/ai/ai-adapter";
import { config } from "@/config";
import type { OutreachTarget } from "./people-finder";

export interface OutreachMessages {
  connectionNote: string; // ≤300 chars
  firstDm: string;
  followup: string;
}

const SYSTEM = `You write short, warm, human LinkedIn outreach messages for a job seeker reaching out for a referral or to a recruiter. Never sound like a mass template or a bot. No emojis. No buzzwords. Respond with a single JSON object only.`;

function buildPrompt(opts: {
  ownerName: string;
  target: OutreachTarget;
  company: string;
  role: string;
  pitch: string;
}): string {
  const { ownerName, target, company, role, pitch } = opts;
  const audience =
    target.role === "RECRUITER"
      ? "a recruiter / talent person at the company (they can move the role forward directly)"
      : "an employee at the company (the ask is a referral or a pointer to the right person)";

  return `## Sender
${ownerName}, an early-career software engineer. Their tailored pitch for THIS role:
"${pitch}"

## Target
Name: ${target.name}
Title/headline: ${target.title ?? "unknown"}
They are ${audience}.

## Role
${role} at ${company}

## Write three messages (truthful to the pitch — never invent facts):
1. connectionNote: the note sent WITH a LinkedIn connection request. MUST be ≤ 280 characters. Friendly, specific to ${company}/${role}, mentions wanting to connect. No hard ask yet.
2. firstDm: sent AFTER they accept. 4–6 short sentences. Warm thanks for connecting, why ${company} specifically, a 1–2 line pitch from the sender's background, then ${target.role === "RECRUITER" ? "express interest in the role and offer to share a resume" : "a soft ask for a referral or a pointer to the right person"}. End with a low-pressure close.
3. followup: a SHORT nudge (2–3 sentences) if no reply after a few days. Polite, references the ${role} role, easy to say no.

Use the sender's first name (${ownerName.split(" ")[0]}) to sign off. Address the target by their first name (${target.name.split(" ")[0]}).

Respond with ONLY this JSON (no markdown):
{ "connectionNote": "...", "firstDm": "...", "followup": "..." }`;
}

export async function writeMessages(opts: {
  target: OutreachTarget;
  company: string;
  role: string;
  pitch: string;
}): Promise<OutreachMessages> {
  const ownerName = config.owner.name || "the candidate";
  try {
    const result = await chatCompletion(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildPrompt({ ownerName, ...opts }) },
      ],
      { temperature: 0.7, response_format: { type: "json_object" } }
    );
    const parsed = parseJsonResponse<OutreachMessages>(result.text);
    return {
      connectionNote: (parsed.connectionNote ?? "").slice(0, 300),
      firstDm: parsed.firstDm ?? fallback(opts).firstDm,
      followup: parsed.followup ?? fallback(opts).followup,
    };
  } catch (err) {
    console.warn("[message-writer] AI generation failed, using template fallback:", err);
    return fallback(opts);
  }
}

/** Deterministic fallback so outreach never blocks on an LLM hiccup. */
function fallback(opts: { target: OutreachTarget; company: string; role: string; pitch: string }): OutreachMessages {
  const owner = (config.owner.name || "").split(" ")[0] || "";
  const them = opts.target.name.split(" ")[0];
  return {
    connectionNote: `Hi ${them}, I came across ${opts.company}'s ${opts.role} opening and noticed you work there. Would love to connect and learn more about the team.`.slice(0, 300),
    firstDm: `Hey ${them}, thanks for connecting.\n\nI'm actively looking for ${opts.role} roles and ${opts.company} really caught my attention. ${opts.pitch}\n\n${opts.target.role === "RECRUITER" ? "Would love to throw my hat in — happy to share my resume." : "Would you be open to referring me, or pointing me to the right person? Happy to share my resume — no pressure if it's not a fit."}\n\nThanks,\n${owner}`,
    followup: `Hey ${them}, just following up in case it got buried — still very interested in the ${opts.role} role at ${opts.company}. Totally fine if it's not the right time. Thanks!`,
  };
}
