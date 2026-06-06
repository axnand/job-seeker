/**
 * Local dev cron — mimics Vercel Cron on your machine.
 *   discover: every 3h   ·   tick (sends queued invites/DMs): every 30 min
 *
 * Run:  npm run cron       (needs the dev server running on APP_BASE_URL)
 * Stop: Ctrl-C
 *
 * The tick respects the send window, rate caps, and the global pause switch —
 * so this is safe to leave running for hands-off automation.
 */

const BASE = process.env.APP_BASE_URL || "http://localhost:3000";
const SECRET = process.env.CRON_SECRET || "";

async function hit(path) {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const body = await r.text();
    console.log(new Date().toLocaleTimeString(), path, r.status, body.slice(0, 200));
  } catch (e) {
    console.error(new Date().toLocaleTimeString(), path, "ERROR", e.message);
  }
}

console.log(`local cron → ${BASE}  (discover 3h · tick 30m)`);
hit("/api/cron/tick");                                  // run once on start
setInterval(() => hit("/api/cron/tick"), 30 * 60 * 1000);
setInterval(() => hit("/api/cron/discover"), 3 * 60 * 60 * 1000);
