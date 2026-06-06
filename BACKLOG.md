# Job Seeker — Backlog (all phases complete)

Status of the original v2 plan. ✅ = done, ⏭️ = intentionally skipped, ⬜ = not built.

**Everything in the v2 plan is now built.** Phases 1–5 + operational items are done
(Phase 4 resume manager came from a parallel session; Phases 2/3/5 + ops below).

---

## ✅ Done (Phase 1 — core loop)
- Discovery from LinkedIn, Adzuna, Remotive, RemoteOK, JSearch (+ dedup)
- AI scoring + salary extraction (tailored to new-grad / India / 14.5 LPA floor)
- Daily digest email with signed Approve/Skip links
- Dashboard: board, job detail, add-job, settings (DB-backed, togglable)
- Two-axis status model (appStage + outreachState)

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

## ✅ Phase 3 — Dashboard polish (done; AI-providers page intentionally skipped)
- ✅ **Outreach review in the board drawer** — the board's own drawer now shows each draft with editable note/DM/follow-up + **Confirm & Send / Cancel** (previously only on the standalone `/jobs/[id]` page). Closes the Phase-2 loop in the primary UI.
11. ✅ **Functional filters/sort** — Source / Apply-type / Score dropdowns + Score/Salary/Date sort now actually filter & sort the board (client-side).
12. ⏭️ **AI Providers page — SKIPPED (by design).** For a single-user tool, the env key + the "default model" field in Settings → AI is enough. A full provider-management CRUD UI is enterprise bloat; the `AiProvider` DB table + `ai-adapter` fallback already support it if ever needed.
13. ✅ **ATS watchlist UI** — Settings → Sources now has an add/remove editor for target companies (name + ATS + board token), wired to `settings.targetCompanies` → `fetchAtsWatchlist`.
14. ✅ **manual-notify email** — `MANUAL_NOTIFY` jobs email the owner the apply link + pitch on approve (`src/email/alerts.ts` → wired in `enqueueOutreach`).
- ✅ Replaced the misleading "Message Templates — Phase 2" placeholder in Settings with an accurate "AI per job, reviewed before send" note.

---

## ✅ Phase 4 — Resume manager (built in the resume session)
15–19. Master upload + storage, AI tailoring gate (`needsTailoring`/`tailoringSuggestions` from the scorer), resume routes (`/api/resume/*`), `/resume` page, and the per-job "Tailoring recommended → upload tailored PDF" gate in the board drawer.

---

## ✅ Phase 5 — LinkedIn post detection (DONE)
20. ✅ **Post search + extraction** (`src/sources/linkedin-posts.ts`) — `category: "posts"` search with `date_posted` recency filter → free keyword pre-filter (hiring signals) → AI extraction (`isJobPost`, company, role, applyMethod, JD) only on survivors. Toggle: Settings → Sources → "LinkedIn Posts".
21. ✅ **`dm_author` routing** — `dm_author`/`comment` posts set `sourcePostAuthorUrl`/`Name` and route `REFERRAL_FIRST`; the people-finder short-circuits to the author (skips search). `link`/`unclear` route `MANUAL_NOTIFY`. Every post runs the identical relevance + salary gates as job-board jobs.

---

## ✅ Operational / deploy (DONE)
22. ✅ **External cron for the free tier** — `.github/workflows/cron.yml` pings `/api/cron/tick` (every 30 min, IST day) and `/api/cron/discover` (a few times daily) with `Authorization: Bearer CRON_SECRET`. Repo secrets: `APP_BASE_URL`, `CRON_SECRET`. (Delete it on Vercel Pro.)
23. ✅ **Staleness auto-archive** (`src/status/staleness.ts`) — runs each discovery; soft-closes NEW jobs never reviewed + APPROVED jobs with no live outreach after `archiveAfterDays`. Never closes jobs with active/successful outreach.
24. ✅ **Cron lock** (`src/lib/cron-lock.ts` + `CronLock` model) — DB row-lock (reliable behind a transaction pooler, unlike session advisory locks) wraps both discover and tick so overlapping runs skip cleanly; a stale lock (>10 min) is reclaimable.
25. **Resume tailoring on Vercel** — LaTeX can't compile on serverless. Current design sidesteps this: the AI produces tailoring *suggestions* and the owner uploads a tailored PDF (no server-side compile needed). Full server-side `.tex`→PDF would still need a hosted compile service.

---

## Notes
- Easy Apply was **dropped** — Unipile has no application-submission API (verified). All jobs route to referral-first or manual-notify.
- LinkedIn account in use is the company Unipile account; for personal outreach you may want your own LinkedIn connected to Unipile.
