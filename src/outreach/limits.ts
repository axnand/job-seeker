/**
 * Outreach rate limits, send window, and warmup ramp — the ban-avoidance layer.
 *
 * Counts use rolling windows (last 24h / last 7d) rather than calendar-day
 * buckets: this is strictly safer for LinkedIn's throttling (we never exceed N
 * invites in ANY 24h span, not just per calendar day) and avoids timezone math.
 */

import { prisma } from "@/lib/prisma";
import { getSettings, type AppSettingsData } from "@/lib/settings";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface SendBudget {
  invitesLeft: number;   // remaining invites in the binding window (min of daily/weekly)
  dmsLeft: number;       // remaining first-DM + followup sends today
  dailyInviteCap: number;
  weeklyInviteCap: number;
  dailyDmCap: number;
  invites24h: number;
  invites7d: number;
  dms24h: number;
  inWarmup: boolean;
}

/**
 * Effective daily invite cap honoring a warmup ramp for a fresh account.
 * Day 0–1 → 5, day 2–4 → 8, then the configured cap. Based on the age of the
 * very first invite ever sent (proxy for "account warmth").
 */
async function effectiveDailyInviteCap(configuredCap: number): Promise<{ cap: number; inWarmup: boolean }> {
  // Count by ChannelThread.inviteSentAt, not ThreadMessage — the "already
  // pending" branch in doSendInvite advances an invite without recording a
  // ThreadMessage, so a message-based count silently undercounts real invites.
  const firstInvite = await prisma.channelThread.findFirst({
    where: { inviteSentAt: { not: null } },
    orderBy: { inviteSentAt: "asc" },
    select: { inviteSentAt: true },
  });
  if (!firstInvite?.inviteSentAt) return { cap: Math.min(configuredCap, 5), inWarmup: true };

  const ageDays = (Date.now() - firstInvite.inviteSentAt.getTime()) / DAY_MS;
  if (ageDays < 2) return { cap: Math.min(configuredCap, 5), inWarmup: true };
  if (ageDays < 5) return { cap: Math.min(configuredCap, 8), inWarmup: true };
  return { cap: configuredCap, inWarmup: false };
}

export async function getSendBudget(settings?: AppSettingsData): Promise<SendBudget> {
  const s = settings ?? (await getSettings());
  const now = Date.now();
  const since24h = new Date(now - DAY_MS);
  const since7d = new Date(now - WEEK_MS);

  const [invites24h, invites7d, dms24h] = await Promise.all([
    // Invites counted by inviteSentAt (one per thread) so the "already pending"
    // branch — which sets inviteSentAt but writes no ThreadMessage — still counts.
    prisma.channelThread.count({ where: { inviteSentAt: { gte: since24h } } }),
    prisma.channelThread.count({ where: { inviteSentAt: { gte: since7d } } }),
    prisma.threadMessage.count({ where: { kind: { in: ["FIRST_DM", "FOLLOWUP"] }, sentAt: { gte: since24h } } }),
  ]);

  const { cap: dailyInviteCap, inWarmup } = await effectiveDailyInviteCap(s.outreach.dailyInviteCap);
  const weeklyInviteCap = s.outreach.weeklyInviteCap;
  const dailyDmCap = s.outreach.dailyDmCap;

  const invitesLeft = Math.max(0, Math.min(dailyInviteCap - invites24h, weeklyInviteCap - invites7d));
  const dmsLeft = Math.max(0, dailyDmCap - dms24h);

  return {
    invitesLeft,
    dmsLeft,
    dailyInviteCap,
    weeklyInviteCap,
    dailyDmCap,
    invites24h,
    invites7d,
    dms24h,
    inWarmup,
  };
}

/** Current hour (0–23) in the owner's send-window timezone (Asia/Kolkata). */
function currentHourIST(): number {
  try {
    const h = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      hour: "numeric",
      hour12: false,
    }).format(new Date());
    return parseInt(h, 10) % 24;
  } catch {
    return new Date().getHours();
  }
}

export function isWithinSendWindow(settings: AppSettingsData): boolean {
  const hour = currentHourIST();
  const { sendWindowStart, sendWindowEnd } = settings.outreach;
  return hour >= sendWindowStart && hour < sendWindowEnd;
}

/** Next time the send window opens, as a Date (used to reschedule a held thread). */
export function nextSendWindowOpen(settings: AppSettingsData): Date {
  const { sendWindowStart } = settings.outreach;
  // IST is UTC+5:30. Compute today's window-open instant in UTC, roll to tomorrow if passed.
  const now = new Date();
  const istNowMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  const istNow = new Date(istNowMs);
  const target = new Date(istNow);
  target.setUTCHours(sendWindowStart, 0, 0, 0);
  if (target.getTime() <= istNowMs) target.setUTCDate(target.getUTCDate() + 1);
  // Convert the IST wall-clock target back to a real UTC instant.
  return new Date(target.getTime() - 5.5 * 60 * 60 * 1000);
}
