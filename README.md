# Job Seeker

Personal job-search automation tool. Finds relevant jobs from multiple sources,
scores them with AI (including salary), emails a daily digest, and sends
LinkedIn outreach after your approval.

## Quick start

```bash
cp .env.example .env          # fill in secrets
npm install
npx prisma migrate dev --name init
npm run dev                   # http://localhost:3000
```

Basic auth password is `APP_PASSWORD` in your `.env`.

## Architecture

```
Vercel Cron /api/cron/discover  (daily, 08:00 IST)
  → source adapters (LinkedIn, Adzuna, ATS watchlist, Remotive, RemoteOK)
  → cross-source dedup
  → AI scorer: score 0-100 + salary extraction (one LLM call)
  → persist to Postgres
  → daily digest email with signed Approve/Skip links

Owner clicks Approve → opens /jobs/{id} → reviews AI message → Confirm send

Vercel Cron /api/cron/tick  (every 30 min, 09:00–21:00 IST)
  → ChannelThread outreach engine (invite → accept → DM → follow-up → archive)
  → poll fallbacks for missed webhooks; rate limits + send window + account safety

Unipile webhook /api/webhooks/unipile
  → invite accepted → CONNECTED; reply → REPLIED + reply-alert email
```

> On the free Vercel tier, crons run only once/day — use the included
> `.github/workflows/cron.yml` (external cron) to drive the 30-min tick.

## Phases

| Phase | Status | What's in it |
|---|---|---|
| 1 — Core loop | ✅ Built | Discovery, scoring, salary, digest email, board UI |
| 2 — Outreach | ✅ Built | People finder, message writer, ChannelThread state machine, tick, reply/accept webhooks + poll fallbacks, rate limits, account safety |
| 3 — Dashboard polish | ✅ Built | Functional filters/sort, in-drawer outreach review + Confirm & Send, ATS watchlist UI (AI-providers page skipped by design) |
| 4 — Resume manager | ✅ Built | Tailoring gate, resume routes, `/resume` page, per-job tailored-PDF upload |
| 5 — LinkedIn posts | ✅ Built | Feed search, keyword pre-filter, AI extraction, dm_author path |
| Ops | ✅ Built | External cron (GitHub Actions), staleness auto-archive, cron lock |
| 6 — Auto resume tailoring | ✅ Built | Paste master `.tex` once; per-job surgical LLM edits gated by a truthfulness whitelist (never invents skills), external LaTeX compile with self-repair, PDF to S3, DMs auto-attach it |
| 7 — Pipeline + analytics | ✅ Built | APPLIED/INTERVIEWING/OFFER stages after REPLIED, `/analytics` conversion funnel per source, friend digests with per-recipient salary floors + optional keyword filters |
| 8 — Ops intelligence | ✅ Built | LLM spend ledger (per-purpose 30-day cost on `/analytics`), Monday weekly report email, PDF output sanity guard on tailored resumes |

## Auto resume tailoring (phase 6)

1. Paste your master LaTeX resume on `/resume` (it's compile-checked on save).
2. Jobs the scorer flags `needsTailoring` get tailored automatically on approve
   (inline in discover; `/api/cron/tailor` is an optional hourly catch-up you
   can add to cron-job.org).
3. Every change is auditable on the job page (find → replace + why), with a
   Regenerate button. Compile/validation failures fall back to the base PDF —
   outreach is never blocked.
4. `npx tsx scripts/sanity-tests.ts` runs the truthfulness/salary-gate tests;
   `npx tsx scripts/test-tailoring-e2e.ts` exercises the real compile services
   and (with a valid `OPENAI_API_KEY`) the live LLM edit + self-repair loop.

## Key files

| File | Purpose |
|---|---|
| `src/config.ts` | All owner preferences and credentials |
| `src/sources/registry.ts` | Runs all adapters, dedupes |
| `src/scoring/ai-scorer.ts` | One LLM call → score + salary |
| `src/salary/normalize.ts` | Annualise + FX convert salary |
| `src/email/digest.ts` | Daily digest HTML email |
| `src/resume/pipeline.ts` | Auto-tailoring: edits → whitelist → compile → S3 |
| `app/api/cron/discover/route.ts` | Main daily pipeline |
| `prisma/schema.prisma` | All models |

## Environment variables

See `.env.example` for the full list. Minimum to run locally:

```
DATABASE_URL=postgresql://...
APP_PASSWORD=your-password
APP_SECRET=32-char-random-string
OPENAI_API_KEY=sk-...   # or add a provider via the dashboard
```

## Deploy to Vercel

1. Push to GitHub
2. Import in Vercel — add all env vars
3. Add a Postgres database (Vercel Postgres or external)
4. Schema deploys itself — the build script runs `prisma db push`
5. Crons are driven externally (cron-job.org / GitHub Actions): `discover`
   daily, `tick` every 30 min, optionally `tailor` hourly — all with
   `Authorization: Bearer $CRON_SECRET` (requests are rejected if the secret
   is unset)
