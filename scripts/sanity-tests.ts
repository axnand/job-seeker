/**
 * Dependency-free sanity tests for the pure-function core:
 * truthfulness whitelist, salary gate, and edit application.
 * Run: npx tsx scripts/sanity-tests.ts   (exits non-zero on failure)
 */

import { buildVocabulary, validateEdits, applyEdits, documentIntroducesClaims } from "../src/resume/whitelist";
import { salaryGate } from "../src/salary/normalize";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { console.log(`  ok  ${name}`); return; }
  failures++;
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

const MASTER = String.raw`\documentclass{article}
\begin{document}
\section{Experience}
Software Engineer at Salescode.ai — built Kafka pipelines processing 500K+ records,
reactive microservices with Java, Spring Boot and PostgreSQL. Cost of ops cut 30\%.
\section{Skills}
Java, Spring Boot, Kafka, Node.js, TypeScript, Docker, AWS
\end{document}`;

const vocab = buildVocabulary(MASTER);

// ── Truthfulness gate ────────────────────────────────────────────────────────
check("vocabulary contains lowercased tech", vocab.includes("kafka") && vocab.includes("java"));

const honest = [{ find: "built Kafka pipelines processing 500K+ records", replace: "built Kafka pipelines that processed 500K+ records", why: "" }];
check("honest rephrase passes", validateEdits(honest, MASTER, vocab, 6).length === 0,
  JSON.stringify(validateEdits(honest, MASTER, vocab, 6)));

const invented = [{ find: "Java, Spring Boot, Kafka", replace: "Java, Spring Boot, Kafka, Kubernetes", why: "" }];
check("invented capitalized skill rejected", validateEdits(invented, MASTER, vocab, 6).length === 1);

const inventedLower = [{ find: "Java, Spring Boot, Kafka", replace: "Java, spring boot, kafka, terraform", why: "" }];
check("invented lowercase skill rejected", validateEdits(inventedLower, MASTER, vocab, 6).length === 1);

const inventedYears = [{ find: "Software Engineer at Salescode.ai", replace: "Software Engineer at Salescode.ai with 8 years experience", why: "" }];
check("invented single-digit metric rejected", validateEdits(inventedYears, MASTER, vocab, 6).length === 1);

const missing = [{ find: "Golang expert", replace: "x", why: "" }];
check("find-string absent from master rejected", validateEdits(missing, MASTER, vocab, 6).length === 1);

const ambiguous = [{ find: "Java", replace: "Java (primary)", why: "" }];
check("ambiguous find-string rejected", validateEdits(ambiguous, MASTER, vocab, 6).length === 1);

const tooMany = Array.from({ length: 8 }, (_, i) => ({ find: `nonexistent-${i}`, replace: "y", why: "" }));
check("over-budget edit list rejected", validateEdits(tooMany, MASTER, vocab, 6).length >= 1);

// ── $-pattern safety in applyEdits ───────────────────────────────────────────
const dollarEdit = [{ find: "Cost of ops cut 30\\%", replace: "Cost of ops cut 30\\% ($$ saved)", why: "" }];
const applied = applyEdits(MASTER, dollarEdit);
check("$$ survives applyEdits literally", applied.includes("($$ saved)"), applied.slice(applied.indexOf("Cost"), applied.indexOf("Cost") + 60));

// ── Whole-document re-check (post compile-repair) ────────────────────────────
check("repair smuggling detected", documentIntroducesClaims(MASTER.replace("Docker, AWS", "Docker, AWS, Rust"), vocab).includes("rust"));
check("clean document introduces nothing", documentIntroducesClaims(applyEdits(MASTER, honest), vocab).length === 0,
  JSON.stringify(documentIntroducesClaims(applyEdits(MASTER, honest), vocab)));

// ── Salary gate ──────────────────────────────────────────────────────────────
const base = { min: 0, max: 0, currency: "INR", period: "year" as const, annualBase: 0, basis: "estimated" as const, confidence: "low" as const };
check("unknown salary kept when not strict", salaryGate(null, 1450000, false).pass);
check("unknown salary rejected when strict", !salaryGate(null, 1450000, true).pass);
check("stated at-floor passes (no buffer)", salaryGate({ ...base, annualBase: 1450000, basis: "stated", confidence: "high" }, 1450000, false).pass);
check("low-confidence estimate at floor fails (1.35x buffer)", !salaryGate({ ...base, annualBase: 1450000 }, 1450000, false).pass);
check("low-confidence estimate above buffer passes", salaryGate({ ...base, annualBase: 2000000 }, 1450000, false).pass);

console.log(failures === 0 ? "\nAll sanity tests passed." : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
