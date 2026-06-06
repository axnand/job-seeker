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

## ⬜ THE BIG GAP — "Approve does nothing" (Phase 2: Outreach engine)

This is why nothing happens on approve. Approve currently only flips `appStage = APPROVED`. It needs to kick off the whole outreach machine:

1. **Wire Approve → outreach** — on approve, enqueue outreach for the job (instead of just changing stage).
2. **People finder** (`src/outreach/people-finder.ts`) — Unipile people search by company + role; also use the job's `hiring_team` (LinkedIn returns it); pick 1–2 targets; dedup against `Contact.lastContactedAt`.
3. **Message writer** (`src/outreach/message-writer.ts`) — AI fills the connection note + first DM from `tailoredPitch` + target profile.
4. **Create rows** — `Contact` + `Outreach` + `ChannelThread` per target.
5. **Outreach tick** (`/api/cron/tick`, currently a no-op) — claim ready threads (`FOR UPDATE SKIP LOCKED`), run the state machine: send invite → wait accept → send DM → follow-up → archive. Enforce rate limits (daily 10 / weekly 60 invites, 3 DMs/day), send window, warmup ramp, global pause.
6. **Outreach message review UI** — editable message in the job drawer + "Confirm & Send" (the "never blind-send" promise). Right now there's no review step.
7. **Unipile reply webhook** (`/api/webhooks/unipile`, currently only dedups) — handle `message_received` → mark thread REPLIED → fire reply-alert email; handle `new_relation` (invite accepted) → advance thread to send the DM.
8. **Reply-alert email** — function exists (`sendReplyAlert`), just not wired to the webhook.
9. **Negative-reply classification** — detect "not hiring / no" and stop the sequence (so status doesn't get stuck at REPLIED).
10. **Account safety** — auto-trip `globalPause` on Unipile `429` / `account_restricted` and email the owner.

---

## ⬜ Phase 3 — Dashboard polish
11. **Functional filters/sort** — the Source/Apply/Score dropdowns + Sort buttons are currently decorative.
12. **AI Providers page** — add/test/delete LLM providers in the UI (currently env-only).
13. **ATS watchlist UI** — add/remove target companies (currently config-only).
14. **manual-notify email** — for `MANUAL_NOTIFY` jobs, email the owner the apply link + tailored resume when approved.

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
