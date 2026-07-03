/**
 * Monday-morning analytics email — the /analytics funnel, delivered.
 * Sent by the discover cron (first run of an IST Monday, gated by
 * settings.ops.lastWeeklyReportAt so re-runs don't double-send).
 */

import { sendMail } from "./mailer";
import { config } from "@/config";
import type { AnalyticsData } from "@/analytics/aggregate";
import { ALL_STAGES } from "@/analytics/aggregate";

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
const usd = (v: number | null) => (v === null ? "—" : `$${v.toFixed(2)}`);

function tile(label: string, value: string): string {
  return `<td style="padding:12px 16px;border:1px solid #e5e7eb;border-radius:10px">
    <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em">${label}</div>
    <div style="font-size:20px;font-weight:700;color:#111827;margin-top:2px">${value}</div>
  </td>`;
}

export async function sendWeeklyReport(a: AnalyticsData): Promise<void> {
  if (!config.owner.email) return;

  const sourceRows = a.bySource.map(r => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #f4f4f5">${r.source}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f4f4f5;text-align:right">${r.jobs}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f4f4f5;text-align:right">${r.approvedPlus}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f4f4f5;text-align:right">${r.invitesSent}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f4f4f5;text-align:right">${r.accepted}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f4f4f5;text-align:right;font-weight:600;color:#059669">${r.replied}</td>
    </tr>`).join("");

  const pipelineLine = ALL_STAGES
    .filter(s => a.pipeline[s] > 0)
    .map(s => `${s}: <b>${a.pipeline[s]}</b>`)
    .join(" &nbsp;·&nbsp; ");

  const spendRows = a.llmSpend.map(r => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #f4f4f5">${r.purpose}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f4f4f5;text-align:right">${r.calls}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f4f4f5;text-align:right">${usd(r.estCostUsd)}</td>
    </tr>`).join("");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="max-width:640px;margin:0 auto;padding:24px;font-family:sans-serif;color:#111827">
  <h2 style="margin:0 0 4px;font-size:18px">Weekly job-search report</h2>
  <p style="margin:0 0 18px;color:#6b7280;font-size:13px">Funnel and spend across all time · full detail on the Analytics page</p>

  <table role="presentation" style="border-collapse:separate;border-spacing:8px;margin:0 -8px 16px"><tr>
    ${tile("Jobs", a.totals.jobs.toLocaleString())}
    ${tile("Approval rate", pct(a.totals.approvalRate))}
    ${tile("Invite → accept", pct(a.totals.inviteAcceptRate))}
    ${tile("Accept → reply", pct(a.totals.acceptReplyRate))}
    ${tile("In pipeline", String(a.totals.inPipeline))}
  </tr></table>

  ${pipelineLine ? `<p style="font-size:13px;color:#374151;margin:0 0 18px">${pipelineLine}</p>` : ""}

  <h3 style="font-size:14px;margin:18px 0 6px">By source</h3>
  <table style="border-collapse:collapse;width:100%;font-size:13px">
    <tr style="color:#6b7280;font-size:11px;text-transform:uppercase">
      <th style="text-align:left;padding:6px 10px">Source</th><th style="text-align:right;padding:6px 10px">Jobs</th>
      <th style="text-align:right;padding:6px 10px">Approved+</th><th style="text-align:right;padding:6px 10px">Invites</th>
      <th style="text-align:right;padding:6px 10px">Accepted</th><th style="text-align:right;padding:6px 10px">Replied</th>
    </tr>
    ${sourceRows || `<tr><td colspan="6" style="padding:10px;color:#9ca3af">No data yet</td></tr>`}
  </table>

  ${a.llmSpend.length > 0 ? `
  <h3 style="font-size:14px;margin:18px 0 6px">LLM spend (30 days)</h3>
  <table style="border-collapse:collapse;width:100%;font-size:13px">
    <tr style="color:#6b7280;font-size:11px;text-transform:uppercase">
      <th style="text-align:left;padding:6px 10px">Purpose</th>
      <th style="text-align:right;padding:6px 10px">Calls</th>
      <th style="text-align:right;padding:6px 10px">Est. cost</th>
    </tr>
    ${spendRows}
  </table>` : ""}
</body></html>`;

  const text = [
    "Weekly job-search report",
    `Jobs: ${a.totals.jobs} | Approval: ${pct(a.totals.approvalRate)} | Invite→accept: ${pct(a.totals.inviteAcceptRate)} | Accept→reply: ${pct(a.totals.acceptReplyRate)} | In pipeline: ${a.totals.inPipeline}`,
    ...a.bySource.map(r => `${r.source}: ${r.jobs} jobs, ${r.replied} replies`),
  ].join("\n");

  await sendMail({
    to: config.owner.email,
    subject: "Weekly job-search report",
    html,
    text,
  });
}
