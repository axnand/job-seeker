/**
 * Daily digest email — one card per scored job above threshold.
 * Approve/Skip links carry signed tokens that open the dashboard job detail page.
 */

import type { Job } from "@prisma/client";
import { createActionToken } from "@/lib/tokens";
import { sendMail } from "./mailer";
import { config } from "@/config";

function formatSalary(job: Job): string {
  if (!job.salaryAnnualBase) return "Salary unknown";
  const base = config.search.baseCurrency;
  const formatted = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: base,
    maximumFractionDigits: 0,
  }).format(job.salaryAnnualBase);
  const badge = job.salaryBasis === "STATED" ? "stated" : `est. ${job.salaryConfidence ?? ""}`;
  return `${formatted}/yr (${badge})`;
}

function applyTypeBadge(job: Job): string {
  return job.applyType === "REFERRAL_FIRST" ? "🤝 Referral First" : "📋 Manual Apply";
}

function sourceBadge(job: Job): string {
  const map: Record<string, string> = {
    LINKEDIN_JOB: "LinkedIn",
    LINKEDIN_POST: "LinkedIn Post",
    ADZUNA: "Adzuna",
    ATS_WATCHLIST: "Watchlist",
    REMOTIVE: "Remotive",
    REMOTEOK: "RemoteOK",
    JSEARCH: "JSearch",
    MANUAL: "Manual",
  };
  return map[job.source] ?? job.source;
}

function jobCard(job: Job): string {
  const approveUrl = `${config.app.baseUrl}/api/webhooks/approval?token=${createActionToken(job.id, "approve")}`;
  const skipUrl = `${config.app.baseUrl}/api/webhooks/approval?token=${createActionToken(job.id, "skip")}`;
  const dashboardUrl = `${config.app.baseUrl}/jobs/${job.id}`;
  const salaryFlagNote = job.salaryFlagReason
    ? `<p style="color:#b45309;font-size:12px;margin:4px 0 0">⚠️ ${job.salaryFlagReason.replace(/_/g, " ")}</p>`
    : "";

  return `
<div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;font-family:sans-serif">
  <div style="display:flex;justify-content:space-between;align-items:flex-start">
    <div>
      <h3 style="margin:0 0 4px;font-size:16px">${job.company}</h3>
      <p style="margin:0 0 8px;color:#374151;font-size:15px"><strong>${job.role}</strong></p>
    </div>
    <div style="text-align:right">
      <span style="background:#dbeafe;color:#1d4ed8;padding:2px 8px;border-radius:9999px;font-size:13px;font-weight:600">${job.aiScore}/100</span>
    </div>
  </div>
  <p style="margin:0 0 4px;font-size:13px;color:#6b7280">${applyTypeBadge(job)} &nbsp;·&nbsp; ${sourceBadge(job)}</p>
  <p style="margin:4px 0;font-size:14px;color:#1f2937">${job.aiReason ?? ""}</p>
  <p style="margin:4px 0;font-size:13px;color:#059669;font-weight:500">${formatSalary(job)}</p>
  ${salaryFlagNote}
  <div style="margin-top:12px;display:flex;gap:8px">
    <a href="${approveUrl}" style="background:#16a34a;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500">✓ Approve</a>
    <a href="${skipUrl}" style="background:#f3f4f6;color:#374151;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:14px">✗ Skip</a>
    <a href="${dashboardUrl}" style="background:#eff6ff;color:#2563eb;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:14px">View →</a>
  </div>
</div>`;
}

export async function sendDailyDigest(jobs: Job[]): Promise<void> {
  if (jobs.length === 0) return;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="max-width:640px;margin:0 auto;padding:20px;font-family:sans-serif">
  <h2 style="margin-bottom:4px">Job Automation — Daily Digest</h2>
  <p style="color:#6b7280;margin-top:0">${jobs.length} job${jobs.length !== 1 ? "s" : ""} matched your profile today</p>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">
  ${jobs.map(jobCard).join("")}
  <p style="color:#9ca3af;font-size:12px;margin-top:24px">
    Approve/Skip links open the dashboard so you can review the outreach message before anything sends.
    <a href="${config.app.baseUrl}" style="color:#6b7280">Open dashboard</a>
  </p>
</body>
</html>`;

  await sendMail({
    to: config.owner.email,
    subject: `[Job Automation] ${jobs.length} new job${jobs.length !== 1 ? "s" : ""} match your profile`,
    html,
    text: jobs.map(j => `${j.company} — ${j.role} (${j.aiScore}/100)`).join("\n"),
  });
}

export async function sendReplyAlert(opts: {
  contactName: string;
  contactTitle: string;
  company: string;
  role: string;
  messageText: string;
  linkedinChatUrl?: string;
  jobId: string;
}): Promise<void> {
  const dashboardUrl = `${config.app.baseUrl}/jobs/${opts.jobId}`;

  const html = `
<!DOCTYPE html>
<html>
<body style="max-width:600px;margin:0 auto;padding:20px;font-family:sans-serif">
  <h2>💬 ${opts.contactName} replied</h2>
  <p><strong>${opts.contactName}</strong> (${opts.contactTitle} at ${opts.company}) replied about <strong>${opts.role}</strong>:</p>
  <blockquote style="border-left:3px solid #e5e7eb;padding:12px 16px;margin:16px 0;background:#f9fafb;color:#374151">
    ${opts.messageText}
  </blockquote>
  <div style="margin-top:16px;display:flex;gap:8px">
    ${opts.linkedinChatUrl ? `<a href="${opts.linkedinChatUrl}" style="background:#0a66c2;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:14px">Open on LinkedIn</a>` : ""}
    <a href="${dashboardUrl}" style="background:#eff6ff;color:#2563eb;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:14px">View job →</a>
  </div>
</body>
</html>`;

  await sendMail({
    to: config.owner.email,
    subject: `[Job Automation] ${opts.contactName} at ${opts.company} replied`,
    html,
    text: `${opts.contactName} replied: ${opts.messageText}`,
  });
}
