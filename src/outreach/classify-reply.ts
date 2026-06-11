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

// Positive/helpful signals that should NEVER be auto-archived as a "no" — even
// if the message also happens to contain a negative-looking substring (e.g.
// "not interested in leaving, but happy to refer you").
const POSITIVE = [
  "happy to refer",
  "will refer",
  "can refer",
  "i'll refer",
  "refer you",
  "shared with",
  "shared your",
  "forwarded",
  "send me your",
  "share your resume",
  "send your resume",
  "send your cv",
  "let's connect",
  "let me know",
  "happy to help",
  "glad to help",
];

export function isNegativeReply(text: string): boolean {
  const t = text.toLowerCase();
  // A clear positive/helpful signal wins — don't stop a sequence that's working.
  if (POSITIVE.some((p) => t.includes(p))) return false;
  return NEGATIVE.some((p) => t.includes(p));
}
