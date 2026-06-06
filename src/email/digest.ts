/**
 * Daily digest email — one card per scored job above threshold.
 * Approve/Skip links carry signed tokens that open the dashboard job detail page.
 */

import type { Job } from "@prisma/client";
import { sendMail } from "./mailer";
import { config } from "@/config";

function formatSalary(job: Job): string {
  if (!job.salaryAnnualBase) return "Salary not stated";
  const base = config.search.baseCurrency;
  const formatted = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: base,
    maximumFractionDigits: 0,
  }).format(job.salaryAnnualBase);
  const badge = job.salaryBasis === "STATED" ? "stated" : `est. ${(job.salaryConfidence ?? "").toLowerCase()}`;
  return `${formatted}/yr · ${badge}`;
}

function formatPosted(job: Job): string {
  const when = job.postedAt ?? job.discoveredAt;
  if (!when) return "";
  const days = Math.floor((Date.now() - new Date(when).getTime()) / 86_400_000);
  const label =
    days <= 0 ? "Posted today" :
    days === 1 ? "Posted yesterday" :
    days < 7 ? `Posted ${days} days ago` :
    days < 14 ? "Posted last week" :
    `Posted ${Math.floor(days / 7)} weeks ago`;
  return job.postedAt ? label : label.replace("Posted", "Found");
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
  // Flow is fully automatic — outreach queues immediately after scoring.
  // No Approve/Skip needed; just a View link + outreach status.
  const dashboardUrl = `${config.app.baseUrl}/jobs/${job.id}`;
  const salaryFlagNote = job.salaryFlagReason
    ? `<p style="color:#b45309;font-size:12px;margin:8px 0 0">⚠️ ${job.salaryFlagReason.replace(/_/g, " ")}</p>`
    : "";

  const fact = (icon: string, text: string, color = "#374151") =>
    `<td style="padding:0 16px 0 0;font-size:13px;color:${color};white-space:nowrap;vertical-align:top">${icon}&nbsp;${text}</td>`;
  const facts = [
    fact("💰", formatSalary(job), job.salaryAnnualBase ? "#059669" : "#9ca3af"),
    job.location ? fact("📍", job.location) : "",
    formatPosted(job) ? fact("🕒", formatPosted(job), "#6b7280") : "",
  ].filter(Boolean).join("");

  // Outreach status line — tells the owner what's already in motion.
  const outreachStatus = job.applyType === "MANUAL_NOTIFY"
    ? `<p style="margin:10px 0 0;font-size:12px;color:#6b7280">📋 Manual apply — no outreach queued. Apply link is in the dashboard.</p>`
    : `<p style="margin:10px 0 0;font-size:12px;color:#2563eb">🤝 Referral outreach queued — connection requests sending in next tick.</p>`;

  return `
<div style="border:1px solid #e5e7eb;border-radius:10px;padding:18px;margin-bottom:14px;font-family:sans-serif">
  <table style="width:100%;border-collapse:collapse"><tr>
    <td style="vertical-align:top">
      <div style="font-size:16px;font-weight:700;color:#111827">${job.company}</div>
      <div style="margin-top:2px;color:#374151;font-size:15px;font-weight:500">${job.role}</div>
    </td>
    <td style="vertical-align:top;text-align:right;white-space:nowrap">
      <span style="background:#dbeafe;color:#1d4ed8;padding:3px 10px;border-radius:9999px;font-size:13px;font-weight:700">${job.aiScore}/100</span>
    </td>
  </tr></table>

  <div style="margin-top:6px;font-size:12px;color:#6b7280">${applyTypeBadge(job)} &nbsp;·&nbsp; ${sourceBadge(job)}</div>

  <table style="margin-top:12px;border-collapse:collapse"><tr>${facts}</tr></table>
  ${salaryFlagNote}

  <p style="margin:12px 0 0;font-size:14px;line-height:1.5;color:#4b5563">${job.aiReason ?? ""}</p>
  ${outreachStatus}

  <div style="margin-top:14px">
    <a href="${dashboardUrl}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">View in dashboard →</a>
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
    Outreach is queuing automatically. Open the dashboard to track replies and manage templates.
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
