import type { Job } from "@prisma/client";
import { sendMail } from "./mailer";

const MIN_ANNUAL_BASE_INR = 800_000; // 8 LPA

function formatSalary(job: Job): string {
  if (!job.salaryAnnualBase) return "";
  const lpa = (job.salaryAnnualBase / 100_000).toFixed(1).replace(/\.0$/, "");
  if (job.salaryMin && job.salaryMax && job.salaryMin !== job.salaryMax) {
    const minLpa = (job.salaryMin / 100_000).toFixed(1).replace(/\.0$/, "");
    const maxLpa = (job.salaryMax / 100_000).toFixed(1).replace(/\.0$/, "");
    return `${minLpa}–${maxLpa} LPA`;
  }
  return `${lpa} LPA`;
}

function truncate(text: string | null, max: number): string {
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max).trimEnd() + "…";
}

function jobCard(job: Job): string {
  const salary = formatSalary(job);
  const desc = truncate(job.jdText, 300);

  return `
<div style="border:1px solid #e5e7eb;border-radius:10px;padding:18px;margin-bottom:14px;font-family:sans-serif">
  <div style="font-size:16px;font-weight:700;color:#111827">${job.company}</div>
  <div style="margin-top:3px;font-size:15px;font-weight:500;color:#374151">${job.role}</div>
  ${salary ? `<div style="margin-top:6px;font-size:13px;color:#059669;font-weight:600">💰 ${salary}</div>` : ""}
  ${desc ? `<p style="margin:10px 0 0;font-size:13px;line-height:1.6;color:#6b7280">${desc}</p>` : ""}
  <div style="margin-top:14px">
    <a href="${job.applyUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:8px 18px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Apply →</a>
  </div>
</div>`;
}

export async function sendFriendDigest(jobs: Job[], overrideTo?: string): Promise<void> {
  // Include jobs where salary is unknown (null) — we can't confirm they're below 8 LPA.
  // Only exclude jobs that are confirmed below 8 LPA.
  const eligible = jobs.filter(j => j.salaryAnnualBase === null || j.salaryAnnualBase >= MIN_ANNUAL_BASE_INR);
  if (eligible.length === 0) return;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="max-width:600px;margin:0 auto;padding:24px;font-family:sans-serif">
  <h2 style="margin-bottom:4px;font-size:18px;color:#111827">Job openings above 8 LPA</h2>
  <p style="margin-top:0;margin-bottom:20px;color:#6b7280;font-size:13px">${eligible.length} opening${eligible.length !== 1 ? "s" : ""} today</p>
  ${eligible.map(jobCard).join("")}
</body>
</html>`;

  const text = eligible.map(j => {
    const salary = formatSalary(j);
    return [
      `${j.role} — ${j.company}`,
      salary ? `Salary: ${salary}` : "",
      truncate(j.jdText, 300),
      `Apply: ${j.applyUrl}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n---\n\n");

  await sendMail({
    to: overrideTo ?? "mmayank.connect@gmail.com",
    subject: `${eligible.length} job opening${eligible.length !== 1 ? "s" : ""} above 8 LPA today`,
    html,
    text,
  });
}
