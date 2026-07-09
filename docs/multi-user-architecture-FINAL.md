# Job-Seeker → Multi-Tenant SaaS: FINAL Architecture
**Date:** 2026-07-08 · **Status:** Consolidated & review-hardened · **Supersedes:** `multi-user-architecture.md` where they conflict

## How to read this
This is the decision-grade synthesis of three companion docs (all in `docs/`):
1. `audit-2026-07-08.md` — gap audit of the current single-tenant code.
2. `multi-user-architecture.md` — the first architecture proposal (Phase 2).
3. `multi-user-architecture-review.md` — an independent red-team of that proposal (Phase 3).

This doc keeps what the proposal got right, folds in the review's valid corrections, resolves the two where they disagree, and ends with the **decisions only you can make** and a **revised roadmap**. No code — design only.

---

## 1. The one reframe that changes everything

The proposal split the product into two planes (Intelligence vs Outreach) and computed the shared-pool ceiling from **invite** limits only. The review proved that wrong by reading the actual code: **discovery and referral-target-finding fire 200+ LinkedIn *search/scrape* calls per user per run on the *same* pool account that also sends invites** (`src/sources/linkedin.ts`, `src/outreach/people-finder.ts` ≈ 20 calls/approved job, `src/unipile/client.ts` pagination). LinkedIn restricts accounts for **scrape/search volume**, not just invites — so the binding constraint is likely *reads*, not *sends*, and the "~40–100 active users" ceiling is optimistic.

**Correct model: three concerns, each with a different scaling law and a different account-safety budget.**

| Concern | What it is | Constraint | How it should scale |
|---|---|---|---|
| **READ** (discovery + people-sourcing) | LinkedIn job search, `getJobDetail`, `getCompanyProfile`, `searchPeople`; plus Adzuna/JSearch/Remotive/RemoteOK | LinkedIn scrape limits **+ shared external-API quotas** | **Do it ONCE, share across tenants** (shared corpus). Isolate LinkedIn reads onto dedicated read accounts or non-LinkedIn sources so scraping never burns a *sender* account. |
| **MATCH** (intelligence) | AI scoring, salary, tailoring, digests, dashboard | **LLM $ + DB** only | Scales ~linearly *iff* scoring runs per-unique-job, not per-user-per-job. Meterable. Sell to everyone. |
| **SEND** (outreach) | invites/DMs via shared pool | **per-account invite/DM safety budget** | Hard-capped by pool size. Capacity-gated opt-in add-on. |

The proposal's "two planes" instinct was right; the review's correction is that **READ must be separated from SEND** (they were conflated onto one account) and **discovery must be a shared corpus, not per-user** (or Plane A's cost goes quadratic). Everything below assumes this corrected model.

---

## 2. Final recommendations (plan ✓ kept / △ changed by review)

| # | Decision | Verdict |
|---|---|---|
| R1 | **Row-level `userId`** tenancy, single DB/schema, `orgId`-ready | ✓ keep |
| R2 | **Data-access layer as PRIMARY isolation**; RLS only as a backstop on user-facing paths | △ downgraded from "RLS everywhere" — the per-account worker reads across all users, so a broad RLS+`SET LOCAL`-in-tx would need a huge `BYPASSRLS` surface and fights the transaction pooler (review S1) |
| R3 | **Shared `Job`/`Company`/hiring-team corpus + per-user `JobMatch` join** (`@@id([userId, jobId])`) | △ **major change** — proposal made `Job` per-user (review C2: quadratic cost/quota). Discover once, match per user, score per unique job. |
| R4 | `Contact` per-user (`@@unique([userId, linkedinProviderId])`) **+ `AccountContactLog` as a TTL cooldown written transactionally at send** | △ changed — proposal's permanent PK starves later users and was racy (review C4) |
| R5 | Auth.js v5 + Prisma adapter; kill shared password; constant-time secret compares | ✓ keep |
| R6 | LinkedIn **pool service** with sticky send-account per user, warmup, quarantine, reassign | ✓ keep — but **split read vs send accounts** (review C1) |
| R7 | Background = **durable queue, fanned out per ACCOUNT** (Inngest/QStash/pg-boss) | ✓ keep; add: budget the people-finder scrape load here, not inside discovery (review S7) |
| R8 | Rate limits = per-account safety budget × per-user quota, **on ROLLING 24h/7d windows** | △ changed — proposal's UTC-day bucket reintroduces the midnight-burst ban risk the current rolling-window code exists to prevent (review S3) |
| R9 | LLM governance: `userId` on `LlmUsage`, pre-call budget check, degradation ladder, **platform-wide circuit breaker** | ✓ keep + add aggregate kill switch (review S6) |
| R10 | **Webhook routing scoped by `account_id` + provider/chat id; alerts to `thread.userId`; `providerChatId` unique per account** | ★ **NEW — the highest-priority fix the proposal omitted** (review C3) |
| R11 | **Concierge relay inbox** as a real product surface; platform-owned third-person persona templates (not user-editable); retrained reply classifier | △ elevated — proposal reduced a whole feature to one clause (review C5) |
| R12 | Stripe tiers **with an actual per-tier P&L** + free-tier abuse controls | △ changed — proposal had no numbers; free tier burning flagship LLM is an abuse vector (review S4) |
| R13 | Migration: expand→backfill→contract, **production-safe DDL** | △ hardened (review C6) |
| R14 | Fold the load-bearing audit fixes into the redesign | ✓ keep (several already landed on `main`) |

---

## 3. The four corrections that would have caused outages (integrated)

### R10 — Multi-tenant webhook routing (the "month-3 breach")
When many users share one LinkedIn account, a Unipile webhook (`invite accepted` / `message received`) carries `account_id` but the current handlers match by `candidateProviderId`/`providerChatId` **only** (`app/api/webhooks/unipile/route.ts`). In a shared pool that can flip the **wrong tenant's** thread and email a recruiter's reply (with their PII) to the **wrong paying customer** — a reportable data breach that is invisible with a single test user.
**Final design:** every webhook thread lookup is scoped by `accountId = data.account_id` **AND** provider/chat id; `providerChatId` becomes unique per `(accountId, chatId)`; reply alerts route to `thread.userId` (not `config.owner`); the poll fallbacks (`outreach-tick.ts` reconcile) iterate per account with per-account day markers. This is also *why* R4's `AccountContactLog` must guarantee one chat ↔ one user.

### R3 — Shared corpus, per-user match (kills quadratic cost)
A public job from Adzuna/LinkedIn is the same for everyone. Making `Job` per-user means: external APIs hit N× (blowing platform-wide quotas in one wave), `getJobDetail` (a paid Unipile call) re-fetched per user, and flagship `gpt-4.1` scoring re-run per user for identical JDs → cost `O(users × overlapping_jobs)`.
**Final design:** a shared, deduped `Job`/`Company` corpus scored **once** (cheap triage → flagship only on top-K). Per-user state lives in `JobMatch { userId, jobId, appStage, aiScore?, pinned, skip… }` — because *relevance is per-user* (each user's profile/floor differs), the **match score** is per-user but derives from the shared JD + a per-user profile pass; keep the expensive extraction shared. Per-account signals like `isConnection` stay per-user/account.
*Trade-off to decide:* fully-shared scoring (cheapest, less personalized) vs a cheap per-user re-rank over shared extraction (recommended middle path).

### R4 — Contact suppression without starvation
A permanent `@@id([accountId, linkedinProviderId])` lock means the first user to reach a popular recruiter locks out everyone else on that account forever; a 3-recruiter startup is exhausted by early users.
**Final design:** suppression is a **TTL cooldown** (e.g. an account won't re-touch the same person for N days), written **transactionally at send time** with a unique constraint as the race arbiter (not a check-then-send at enqueue). Keep strict account-stickiness only for an *in-flight* thread's invite→DM continuity; allow cold *sourcing* to look across accounts so later users aren't starved.

### R13 — Production-safe migration
The `@@unique([threadId, providerMessageId])` the code already assumes **will fail to create** — duplicate rows exist today (audit E3). Prisma's non-`CONCURRENTLY` index builds take `ACCESS EXCLUSIVE` locks; `SET NOT NULL` full-scans; old unscoped writes during "expand" create NULL-`userId` rows; enabling RLS before all raw-`prisma` paths are migrated makes un-migrated code see zero rows.
**Final sequence:** dedupe messages → `CREATE INDEX CONCURRENTLY` → `ADD CONSTRAINT NOT VALID` then `VALIDATE` → dual-write settings during the `id:"default"`→`userId` transition → make `userId` NOT NULL only after backfill verified → **enable RLS strictly last.** Keep `id-cache`/company-size **globally shared** (public reference data — do not shard per user).

---

## 4. Decisions only you can make (these gate the build)

The audit → plan → review chain surfaced three forks the architecture can't resolve on its own. I'll ask them interactively after this doc, but stating them here for the record:

**D1 — Given the corrected read/scrape ceiling, is shared-pool *outreach* viable at all, or does BYO-LinkedIn move to the front?**
The honest ceiling is now *below* 40–100 active users, and scraping on sender accounts is a ban vector. Options: (a) launch outreach on the pool for a tiny waitlisted cohort while building BYO; (b) make outreach **BYO-LinkedIn only** from day one (removes the ceiling *and* the impersonation problem, at each user's own risk); (c) pool for reads via dedicated read accounts + BYO for sends.

**D2 — Concierge relay inbox: build it, or descope concierge?**
Shared-account outreach only works honestly via a third-person "concierge" persona — but that dead-ends at the first reply unless you build a **relay inbox** (a real product surface: proxying the whole conversation between recruiter↔candidate). Build it, or gate outreach to BYO where the user just replies as themselves?

**D3 — LinkedIn ToS / legal sign-off is a go/no-go gate, not a footnote.**
Automated outreach violates LinkedIn's User Agreement regardless of persona framing; scraped third-party contact PII carries GDPR exposure far beyond a personal tool. This needs a real legal decision before Plane-B launch (and possibly region-gating).

---

## 5. Revised phased roadmap

```
MVP — "Intelligence", monetizable, unbounded (the safe money):
  auth · row-level userId + data-access layer · shared job corpus + per-user JobMatch (R3)
  · per-user settings/resume/S3 · LLM metering + caps + platform circuit breaker (R9)
  · Stripe Free/Starter/Pro with a real per-tier P&L (R12) · opt-in digests (double-opt-in + unsubscribe)
  → sell to everyone; outreach OFF (or owner-only). No pool, no impersonation risk yet.

V1 — "Outreach", capacity-gated (only after D1/D2/D3 resolved):
  pool service with SEPARATE read vs send accounts (R6/C1) · per-account fan-out queue (R7)
  · rolling-window two-level rate limits (R8) · concierge persona + relay inbox (R11) OR BYO-only (D1)
  · webhook routing scoped by account_id (R10) · TTL contact suppression (R4)
  · outreach opt-in + waitlist · admin pool console + shadowban monitor (S6)
  → first small cohort of activated outreach users, watched closely.

V2 — scale & integrity:
  BYO-LinkedIn as the primary outreach path (removes ceiling + impersonation) · Team tier (orgId)
  · metered LLM overage · DSAR automation + suppression lists + regional kill switches.
```

The migration (§R13) runs underneath MVP: the existing owner becomes user #1 on the new schema, non-breaking, reversible per phase.

---

## 6. Open risks & go/no-go gates
1. **Read/scrape ceiling (review C1)** — measure per-account safe *search* volume before committing to pool-based discovery. Spike first.
2. **Webhook cross-tenant routing (R10)** — must ship with the pool, not after. Non-negotiable.
3. **LinkedIn ToS + GDPR (D3)** — legal go/no-go before any multi-user sending.
4. **Unit economics (R12)** — flagship LLM per unique job + Unipile per-account fixed cost; a free tier with no payment friction is an LLM-farming vector. Model the P&L before pricing.
5. **Unipile is a SPOF** for all of Plane B; degrade gracefully (pause SEND; READ/MATCH unaffected).

**Bottom line:** the tenancy conversion is routine row-level `userId` work. The genuinely hard, must-get-right parts are: (1) separating READ from SEND and sharing the job corpus, (2) webhook tenant-routing, and (3) whether shared-pool outreach is even the right primary vs BYO. Build the Intelligence plane now — it's the scalable, monetizable, low-risk core — and treat Outreach as a carefully-gated, legally-signed-off, capacity-limited add-on.
