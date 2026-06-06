/**
 * Operational alert emails (separate from the daily digest / reply alerts).
 */

import { sendMail } from "./mailer";
import { config } from "@/config";

export async function sendPauseAlert(reason: string): Promise<void> {
  if (!config.owner.email) return;
  const html = `
<!DOCTYPE html>
<html>
<body style="max-width:600px;margin:0 auto;padding:20px;font-family:sans-serif">
  <h2 style="color:#b91c1c">⛔ Outreach paused automatically</h2>
  <p>The system detected a LinkedIn account distress signal and tripped the global
  pause to protect your account. No further invites or DMs will be sent until you
  re-enable outreach in Settings.</p>
  <blockquote style="border-left:3px solid #fca5a5;padding:12px 16px;margin:16px 0;background:#fef2f2;color:#7f1d1d">
    ${reason}
  </blockquote>
  <p style="font-size:14px;color:#374151">Recommended: wait at least 24h, confirm
  the account is healthy on LinkedIn, then turn off Global Pause in
  <a href="${config.app.baseUrl}/settings">Settings</a>.</p>
</body>
</html>`;
  await sendMail({
    to: config.owner.email,
    subject: "[Job Automation] ⛔ Outreach auto-paused (account safety)",
    html,
    text: `Outreach auto-paused: ${reason}`,
  });
}

export async function sendManualNotify(opts: {
  jobId: string;
  company: string;
  role: string;
  applyUrl: string;
  tailoredPitch?: string | null;
}): Promise<void> {
  if (!config.owner.email) return;
  const dashboardUrl = `${config.app.baseUrl}/jobs/${opts.jobId}`;
  const html = `
<!DOCTYPE html>
<html>
<body style="max-width:600px;margin:0 auto;padding:20px;font-family:sans-serif">
  <h2>📋 Ready to apply — ${opts.company}</h2>
  <p>You approved <strong>${opts.role}</strong> at <strong>${opts.company}</strong>.
  This role has no referral path, so it's a manual apply.</p>
  ${opts.tailoredPitch ? `<p style="font-size:14px;color:#374151"><strong>Your pitch / cover note:</strong></p>
  <blockquote style="border-left:3px solid #c7d2fe;padding:12px 16px;margin:8px 0 16px;background:#eef2ff;color:#3730a3;white-space:pre-line">${opts.tailoredPitch}</blockquote>` : ""}
  <div style="margin-top:16px;display:flex;gap:8px">
    <a href="${opts.applyUrl}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Open application →</a>
    <a href="${dashboardUrl}" style="background:#eef2ff;color:#4338ca;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:14px">View job</a>
  </div>
  <p style="font-size:13px;color:#6b7280;margin-top:16px">After you apply, mark the job
  <em>Applied</em> on the dashboard so tracking stays accurate.</p>
</body>
</html>`;
  await sendMail({
    to: config.owner.email,
    subject: `[Job Automation] Apply: ${opts.role} at ${opts.company}`,
    html,
    text: `Apply to ${opts.role} at ${opts.company}: ${opts.applyUrl}`,
  });
}
