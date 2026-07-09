/**
 * Truthfulness gate for automated resume tailoring.
 *
 * The invariant: a tailored resume may REORDER, REPHRASE, or EMPHASIZE what the
 * master resume already claims — it may never introduce a technology, tool,
 * company, credential, or metric that the master doesn't contain. The LLM is
 * instructed to obey this, but instructions aren't guarantees, so every
 * replacement string is checked deterministically against a vocabulary built
 * from the master .tex. Any new tech-looking token → the edit is rejected.
 */

export interface TailorEdit {
  find: string;     // exact substring of the master .tex, must occur exactly once
  replace: string;  // replacement text
  why: string;      // one-line justification tied to the JD
}

export interface EditViolation {
  edit: TailorEdit;
  reason: string;
}

/** Strip LaTeX commands/comments down to human-visible words. */
function visibleText(tex: string): string {
  return tex
    .replace(/(?<!\\)%.*$/gm, " ")            // comments
    .replace(/\\[a-zA-Z@]+\*?/g, " ")         // \commands
    .replace(/[{}\[\]$&~^_]/g, " ")           // structural chars
    .replace(/\\\\/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Tokens that could constitute a factual claim: capitalized words, ALL-CAPS
 * acronyms, tech-style tokens (Node.js, CI/CD, C++, k8s, gpt-4), numbers with
 * units/multipliers (500K, 10,000+, 99.9%, bare "8"), AND plain lowercase
 * words of 3+ chars ("kubernetes", "terraform") — lowercase tech names are
 * claims too; generic resume English is exempted via GENERIC_ALLOW instead.
 */
const CLAIM_TOKEN = /[A-Za-z][A-Za-z0-9]*(?:[.+/#-][A-Za-z0-9]+)+|\b[A-Z][a-zA-Z0-9]*\b|\b\d[\d,.]*\s*(?:%|\+|[KkMmBb]\b|LPA\b|hrs?\b|x\b)?|\b[a-z][a-z0-9]{2,}\b/g;

function claimTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.match(CLAIM_TOKEN) ?? []) {
    const t = m.trim().toLowerCase().replace(/[,.]+$/, "");
    // Single digits are claims ("8 years"); single letters are not.
    if (t.length >= 2 || /^\d$/.test(t)) out.add(t);
  }
  return out;
}

/** Words that are fine to introduce even though they match CLAIM_TOKEN (they
 *  start sentences / are generic resume verbs+nouns, not skills or facts). */
const GENERIC_ALLOW = new Set([
  "developed", "designed", "built", "led", "improved", "implemented", "created",
  "delivered", "engineered", "architected", "optimized", "optimised", "reduced",
  "increased", "migrated", "maintained", "automated", "integrated", "collaborated",
  "spearheaded", "streamlined", "enhanced", "achieved", "drove", "shipped", "owned",
  "the", "a", "an", "and", "with", "for", "using", "across", "via", "including",
  "experience", "team", "teams", "product", "production", "backend", "frontend",
  "software", "engineer", "engineering", "developer", "development", "systems",
  "services", "applications", "features", "solutions", "projects", "impact",
  "scalable", "reliable", "robust", "efficient", "high-performance",
  // Common resume English that became checkable once lowercase tokens counted
  // as claims — none of these assert a skill or fact by themselves.
  "years", "months", "work", "working", "worked", "building", "leading",
  "managing", "writing", "testing", "ensuring", "improving", "reducing",
  "code", "codebase", "tools", "workflows", "pipelines", "modern", "strong",
  "hands", "end-to-end", "cross-functional", "results", "growth", "ownership",
]);

/** Closed-class English function words — never factual claims. Content words
 *  can't be enumerated (that's what vocab + stem matching is for), but function
 *  words can. */
const STOPWORDS = new Set([
  "the", "and", "that", "which", "with", "from", "into", "onto", "over", "under",
  "while", "where", "when", "than", "then", "they", "them", "their", "there",
  "this", "these", "those", "has", "have", "had", "was", "were", "are", "is",
  "been", "being", "its", "also", "both", "each", "per", "via", "more", "most",
  "less", "least", "very", "well", "who", "whom", "whose", "what", "how", "why",
  "can", "could", "will", "would", "should", "may", "might", "must", "not",
  "all", "any", "some", "such", "own", "same", "other", "another", "between",
  "through", "during", "before", "after", "above", "below", "about", "against",
  "because", "until", "unless", "within", "without", "across", "along", "toward",
]);

/** Crude inflection stem: "processed"/"processing"/"processes" → "process".
 *  Only used for vocabulary membership, never for output. */
function stem(t: string): string {
  let s = t.replace(/'s$/, "");
  for (const suf of ["ing", "ed", "es", "s", "e"]) {
    if (s.length - suf.length >= 3 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  }
  return s;
}

/** True when token t is a claim the master resume doesn't already make. */
function isNewClaim(t: string, vocab: Set<string>, vocabStems: Set<string>): boolean {
  if (vocab.has(t) || GENERIC_ALLOW.has(t) || STOPWORDS.has(t)) return false;
  return !vocabStems.has(stem(t));
}

function stemsOf(vocabulary: string[]): Set<string> {
  return new Set(vocabulary.map(stem));
}

/** Build the master vocabulary (store in ResumeProfile.whitelist). */
export function buildVocabulary(masterTex: string): string[] {
  return [...claimTokens(visibleText(masterTex))].sort();
}

/**
 * Validate proposed edits against the master text + vocabulary.
 * Returns violations; an empty array means every edit is safe to apply.
 */
export function validateEdits(
  edits: TailorEdit[],
  masterTex: string,
  vocabulary: string[],
  maxEdits: number,
  // enforceTruthfulness=false (settings.ai.truthfulTailoring off) keeps every
  // STRUCTURAL check (find exists + unique, brace balance) but SKIPS the
  // "no new claim" vocabulary check — the owner has opted into adding
  // adjacent JD-relevant skills the master doesn't contain.
  opts: { enforceTruthfulness?: boolean } = {},
): EditViolation[] {
  const enforceTruthfulness = opts.enforceTruthfulness !== false;
  const vocab = new Set(vocabulary);
  const violations: EditViolation[] = [];

  if (edits.length > maxEdits) {
    return [{ edit: edits[maxEdits], reason: `too many edits (${edits.length} > ${maxEdits}) — tailoring must stay surgical` }];
  }

  for (const edit of edits) {
    if (!edit.find || typeof edit.find !== "string" || typeof edit.replace !== "string") {
      violations.push({ edit, reason: "malformed edit (find/replace must be strings)" });
      continue;
    }
    const occurrences = masterTex.split(edit.find).length - 1;
    if (occurrences === 0) {
      violations.push({ edit, reason: "find-string not present in master .tex (must be copied verbatim)" });
      continue;
    }
    if (occurrences > 1) {
      violations.push({ edit, reason: `find-string is ambiguous (${occurrences} occurrences) — include more surrounding context` });
      continue;
    }
    // Structural safety: an edit may not change LaTeX structure balance.
    const braceDelta = (edit.replace.match(/(?<!\\)\{/g)?.length ?? 0) - (edit.replace.match(/(?<!\\)\}/g)?.length ?? 0);
    const braceDeltaFind = (edit.find.match(/(?<!\\)\{/g)?.length ?? 0) - (edit.find.match(/(?<!\\)\}/g)?.length ?? 0);
    if (braceDelta !== braceDeltaFind) {
      violations.push({ edit, reason: "replacement changes brace balance — would break LaTeX structure" });
      continue;
    }
    // Truthfulness: every claim-token in the replacement must already exist in
    // the master vocabulary (directly or as an inflection), or be closed-class /
    // generic resume English. Skipped entirely in relaxed mode.
    if (enforceTruthfulness) {
      const vocabStems = stemsOf(vocabulary);
      const newTokens = [...claimTokens(visibleText(edit.replace))]
        .filter(t => isNewClaim(t, vocab, vocabStems));
      if (newTokens.length > 0) {
        violations.push({ edit, reason: `introduces claims not in master resume: ${newTokens.slice(0, 5).join(", ")}` });
      }
    }
  }
  return violations;
}

/** Apply validated edits. Caller must have run validateEdits first. */
export function applyEdits(masterTex: string, edits: TailorEdit[]): string {
  let out = masterTex;
  // Function replacer: LaTeX is $-heavy and String.replace treats $$/$&/$` in a
  // string replacement as substitution patterns, silently corrupting the output.
  for (const e of edits) out = out.replace(e.find, () => e.replace);
  return out;
}

/**
 * Whole-document truthfulness check — used after LLM compile-repair, which
 * rewrites the full source and could smuggle in new claims. Returns the claim
 * tokens present in `tex` but absent from the master vocabulary.
 */
export function documentIntroducesClaims(tex: string, vocabulary: string[]): string[] {
  const vocab = new Set(vocabulary);
  const vocabStems = stemsOf(vocabulary);
  return [...claimTokens(visibleText(tex))].filter(t => isNewClaim(t, vocab, vocabStems));
}
