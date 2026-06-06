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

export async function sendPoolExhaustedAlert(opts: {
  jobId: string;
  company: string;
  role: string;
  accepted: number;
  connectTarget: number;
  totalSent: number;
  maxInvites: number;
  reason: "ceiling" | "no_candidates";
}): Promise<void> {
  if (!config.owner.email) return;
  const dashboardUrl = `${config.app.baseUrl}/jobs/${opts.jobId}`;
  const { company, role, accepted, connectTarget, totalSent, maxInvites, reason } = opts;

  const reasonText =
    reason === "ceiling"
      ? `Hit the ${maxInvites}-invite ceiling before reaching the ${connectTarget}-accept target.`
      : `LinkedIn returned no more candidates for this company.`;

  const html = `
<!DOCTYPE html>
<html>
<body style="max-width:600px;margin:0 auto;padding:20px;font-family:sans-serif">
  <h2 style="color:#92400e">⚠️ Pool exhausted — ${company}</h2>
  <p>The outreach pipeline for <strong>${role}</strong> at <strong>${company}</strong>
  has been stopped: ${reasonText}</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
    <tr style="background:#fef3c7">
      <td style="padding:8px 12px;border:1px solid #fde68a;color:#78350f"><strong>Accepted</strong></td>
      <td style="padding:8px 12px;border:1px solid #fde68a;color:#92400e">${accepted} / ${connectTarget} target</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;color:#374151"><strong>Total invites sent</strong></td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;color:#374151">${totalSent} / ${maxInvites} cap</td>
    </tr>
  </table>
  <p style="font-size:14px;color:#374151">No further invites will be sent for this job automatically.
  If you want to raise the cap or try different people, adjust
  <a href="${config.app.baseUrl}/settings">Settings → Pipeline</a> and the next replenish tick will retry.</p>
  <a href="${dashboardUrl}" style="display:inline-block;margin-top:8px;background:#f59e0b;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">View job →</a>
</body>
</html>`;

  await sendMail({
    to: config.owner.email,
    subject: `[Job Automation] ⚠️ Pool exhausted: ${role} at ${company} (${accepted}/${connectTarget} connected)`,
    html,
    text: `Pool exhausted for ${role} at ${company}. ${accepted}/${connectTarget} accepted, ${totalSent}/${maxInvites} sent. Reason: ${reasonText}`,
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
