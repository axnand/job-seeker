# Job Seeker — Remaining Backlog

Status of the original v2 plan. ✅ = done & tested, 🔨 = in progress, ⬜ = not built.

---

## ✅ Done (Phase 1 — core loop)
- Discovery from LinkedIn, Adzuna, Remotive, RemoteOK, JSearch (+ dedup)
- AI scoring + salary extraction (tailored to new-grad / India / 14.5 LPA floor)
- Daily digest email with signed Approve/Skip links
- Dashboard: board, job detail, add-job, settings (DB-backed, togglable)
- Two-axis status model (appStage + outreachState)

---

## 🔨 In focus now
- **Resume / LaTeX tailoring** (Phase 4) — AI tailors resume per JD, compiles to PDF

---

## ✅ Phase 2 — Outreach engine (DONE — "Approve" now drives the whole machine)

Adapted from Hirro's hardened thread-worker. All crash/race/edge-case machinery ported.

1. ✅ **Wire Approve → outreach** — `enqueueOutreach()` runs on approve (`app/api/jobs/action`).
2. ✅ **People finder** (`src/outreach/people-finder.ts`) — hiring_team → people search; `dm_author` short-circuit; dedup vs `Contact` cooldown; recruiters prioritized.
3. ✅ **Message writer** (`src/outreach/message-writer.ts`) — AI note + first DM + follow-up, with deterministic template fallback.
4. ✅ **Create rows** — `Contact` (upsert) + `Outreach` + `ChannelThread` in DRAFT phase.
5. ✅ **Outreach tick** (`src/outreach/outreach-tick.ts` ← `/api/cron/tick`) — `FOR UPDATE SKIP LOCKED` claim (nulls nextActionAt), state machine (invite→accept→DM→follow-up→archive), retry-on-fail, circuit breaker, pending-send marker, status-guarded commit, poll fallbacks for missed webhooks (acceptances + replies), silent-accept recheck on invite timeout. Rate limits in `src/outreach/limits.ts` (rolling 24h/7d invite caps, DM cap, send window IST, warmup ramp).
6. ✅ **Outreach review UI** — editable note/DM/follow-up in the job drawer + Confirm & Send / Cancel ("never blind-send"). DRAFT threads are never claimed until confirmed. `app/api/outreach/confirm`.
7. ✅ **Unipile webhook** (`app/api/webhooks/unipile`) — `new_relation`→CONNECTED, `message_received`→REPLIED (with out-of-order backfill), shared-secret + HMAC auth.
8. ✅ **Reply-alert email** — wired via `handleInboundReply`.
9. ✅ **Negative-reply classification** (`src/outreach/classify-reply.ts`) — stops the sequence on "no".
10. ✅ **Account safety** (`src/outreach/safety.ts`) — auto-trip `globalPause` on Unipile 429 / restricted, emails the owner.

Also fixed: Unipile client now uses the verified endpoints (`/users/invite`, multipart `/chats`, `fetchProfile?linkedin_sections=*`, `cancelInvitation`, `listChatMessages`).

---

## ⬜ Phase 3 — Dashboard polish
11. **Functional filters/sort** — the Source/Apply/Score dropdowns + Sort buttons are currently decorative.
12. **AI Providers page** — add/test/delete LLM providers in the UI (currently env-only).
13. **ATS watchlist UI** — add/remove target companies (currently config-only).
14. ✅ **manual-notify email** — `MANUAL_NOTIFY` jobs email the owner the apply link + pitch on approve (`src/email/alerts.ts` → wired in `enqueueOutreach`).

---

## ⬜ Phase 4 — Resume manager (LaTeX) ← building now
15. Master `.tex` upload + storage (S3 configured)
16. AI tailors marked sections (`% AI-EDITABLE`) per JD
17. Compile `.tex` → PDF (compiler abstraction; tectonic local / hosted for Vercel)
18. Resume manager UI — view/upload/preview/download, per-job tailoring
19. Region-guard + compile-failure fallback (revert to master)

---

## ⬜ Phase 5 — LinkedIn post detection
20. Feed/post search (`category: "posts"`), keyword pre-filter → AI extraction
21. `dm_author` routing (post author becomes the outreach target — skip people finder)

---

## ⬜ Operational / deploy
22. **Vercel cron hobby-tier limit** — free tier runs crons only once/day. The 30-min outreach tick needs an external cron (cron-job.org / GitHub Actions) hitting `/api/cron/tick`, or Vercel Pro.
23. **Staleness auto-archive** — cron to soft-close jobs with no outreach after 21 days.
24. **Advisory lock on discover cron** — prevent double-runs if worker + cron overlap.
25. **Resume tailoring on Vercel** — LaTeX can't compile on serverless; either local-only generation or a hosted compile service.

---

## Notes
- Easy Apply was **dropped** — Unipile has no application-submission API (verified). All jobs route to referral-first or manual-notify.
- LinkedIn account in use is the company Unipile account; for personal outreach you may want your own LinkedIn connected to Unipile.
