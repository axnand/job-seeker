/**
 * One-off: render the daily digest with sample jobs and send it to OWNER_EMAIL.
 * Run: tsx --env-file=.env scripts/test-digest.ts
 */
import type { Job } from "@prisma/client";
import { sendDailyDigest } from "@/email/digest";

const now = Date.now();
const daysAgo = (d: number) => new Date(now - d * 86_400_000);

const sample = [
  {
    company: "Bidwiser",
    role: "Full Stack Engineer",
    source: "LINKEDIN_JOB",
    applyType: "REFERRAL_FIRST",
    location: "Bengaluru, India (Hybrid)",
    aiScore: 70,
    aiReason:
      "Strong stack fit — full-stack role using Java and AWS, matching the candidate's experience. Salary isn't explicitly stated, so it's uncertain whether it clears the 14.5 LPA floor.",
    salaryAnnualBase: 1650000,
    salaryBasis: "ESTIMATED",
    salaryConfidence: "MEDIUM",
    postedAt: daysAgo(0),
  },
  {
    company: "Uniphore",
    role: "Software Engineer",
    source: "LINKEDIN_JOB",
    applyType: "MANUAL",
    location: "Remote (India)",
    aiScore: 70,
    aiReason:
      "Backend-leaning SDE role at a well-funded AI company. Seniority band fits new-grad / SDE-1 and the tech stack overlaps well.",
    salaryAnnualBase: 1800000,
    salaryBasis: "STATED",
    postedAt: daysAgo(3),
  },
  {
    company: "Razorpay",
    role: "Associate Software Engineer",
    source: "ATS_WATCHLIST",
    applyType: "MANUAL",
    location: "Bengaluru, India",
    aiScore: 82,
    aiReason:
      "Target-company watchlist hit. Entry-level fintech backend role, Java + microservices, comfortably above the pay floor.",
    salaryAnnualBase: 2200000,
    salaryBasis: "ESTIMATED",
    salaryConfidence: "HIGH",
    postedAt: daysAgo(6),
  },
  {
    company: "Quiet Startup",
    role: "Backend Engineer",
    source: "REMOTIVE",
    applyType: "REFERRAL_FIRST",
    location: null,
    aiScore: 66,
    aiReason:
      "Remote backend role with a relevant stack, but the listing is light on details and salary wasn't disclosed.",
    salaryAnnualBase: null,
    salaryFlagReason: "NO_SALARY_STATED",
    postedAt: null,
    discoveredAt: daysAgo(1),
  },
].map((j, i) => ({
  id: `sample-${i}`,
  jdText: "",
  applyUrl: "https://example.com",
  dedupeKey: `sample-${i}`,
  appStage: "NEW",
  outreachState: "NONE",
  needsTailoring: false,
  discoveredAt: daysAgo(0),
  createdAt: daysAgo(0),
  updatedAt: daysAgo(0),
  ...j,
})) as unknown as Job[];

sendDailyDigest(sample)
  .then(() => {
    console.log(`✓ Test digest sent (${sample.length} sample jobs)`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("✗ Failed to send:", err);
    process.exit(1);
  });
