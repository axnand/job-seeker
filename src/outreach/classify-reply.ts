/**
 * Cheap, deterministic negative-reply detector (design §19 #5: "Stop on no.").
 * Keyword-based so it costs zero LLM calls and never blocks the tick. A negative
 * reply halts the sequence so status doesn't get stuck at REPLIED.
 */

const NEGATIVE = [
  "not hiring",
  "no longer hiring",
  "not looking",
  "no openings",
  "no opening",
  "not a fit",
  "not the right fit",
  "no positions",
  "position has been filled",
  "role is filled",
  "already filled",
  "we have filled",
  "not interested",
  "please stop",
  "stop messaging",
  "remove me",
  "don't contact",
  "do not contact",
  "unsubscribe",
  "no thank",
  "no thanks",
  "we're good",
  "not at this time",
  "unfortunately we",
];

export function isNegativeReply(text: string): boolean {
  const t = text.toLowerCase();
  return NEGATIVE.some((p) => t.includes(p));
}
