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
  → Phase 2: ChannelThread outreach engine (invite → DM → follow-up)

Unipile webhook /api/webhooks/unipile
  → Phase 2: mark replied, fire reply-alert email
```

## Phases

| Phase | Status | What's in it |
|---|---|---|
| 1 — Core loop | ✅ Built | Discovery, scoring, salary, digest email, board UI |
| 2 — Outreach | 🔜 Next | People finder, message writer, ChannelThread engine, reply webhooks |
| 3 — Dashboard polish | 🔜 | Settings UI, AI providers page, stats |
| 4 — Resume manager | 🔜 | LaTeX upload, AI tailoring, PDF compile |
| 5 — LinkedIn posts | 🔜 | Feed search, post extraction, dm_author path |

## Key files

| File | Purpose |
|---|---|
| `src/config.ts` | All owner preferences and credentials |
| `src/sources/registry.ts` | Runs all adapters, dedupes |
| `src/scoring/ai-scorer.ts` | One LLM call → score + salary |
| `src/salary/normalize.ts` | Annualise + FX convert salary |
| `src/email/digest.ts` | Daily digest HTML email |
| `src/lib/tokens.ts` | HMAC signed Approve/Skip tokens |
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
4. Run `npx prisma migrate deploy` in the Vercel build command or a one-off
5. `vercel.json` already defines the two cron schedules
