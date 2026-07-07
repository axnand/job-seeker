# Job-Seeker → Multi-Tenant SaaS: Architecture Plan

**Date:** 2026-07-08 · **Author:** Principal eng / SaaS architect · **Status:** Proposal for review
**Companion doc:** `docs/audit-2026-07-08.md` (current-code gap audit — read its "multi-user headline" first)

> Scope: how to convert the current **hard single-tenant** job-seeker automation app into a commercial,
> self-serve, multi-tenant SaaS for 100s–1000s of users, honoring the four locked product decisions
> (shared LinkedIn pool, pooled/metered LLM, self-serve public signup, fully-automatic-but-opt-in outreach).
> This is a design document. No application code — schema sketches and pseudo-flows only.

---

## 0. Executive summary & the one decision that shapes everything

The app is single-tenant in **every** layer: `AppSettings`/`ResumeProfile` are literal `id="default"`
singleton rows; `Job`/`Contact`/`Outreach`/`ChannelThread`/`ThreadMessage`/`LlmUsage` carry **no `userId`**;
rate limits count **globally**; the LinkedIn account is `config.owner.linkedinAccountId`; auth is one shared
password. Turning this into a SaaS is mostly mechanical **except** for one thing that is not mechanical at all
and must drive the entire GTM:

**A shared pool of ~29 LinkedIn accounts cannot serve 1000s of users doing outreach. The real ceiling is on
the order of 40–100 *concurrently-active outreach* users (Section 1). Signups can be unlimited; *outreach
activations* cannot.**

The single most important architectural decision is therefore **not** a tenancy-model choice — it is to
**split the product into two planes with independent scaling laws:**

| Plane | What it is | Scaling limit | GTM |
|---|---|---|---|
| **Plane A — Intelligence** | Discovery, AI scoring, salary normalization, resume tailoring, digests, dashboard | Only **LLM $ and DB** — meterable, ~linear, scales to 1000s | Sell to everyone; public signup |
| **Plane B — Outreach** | Automated LinkedIn invites/DMs via the shared pool | **Hard-capped by pool throughput** (~40–100 active users) | Capacity-gated add-on with a **waitlist / concurrency cap**; opt-in |

Everything below is designed so Plane A scales freely and Plane B degrades gracefully under a hard ceiling
instead of silently failing or getting accounts banned.

**Top-line recommendations (defended in the sections noted):**

1. **Tenancy:** single shared DB, shared schema, **row-level `userId`** on every tenant-owned table, enforced
   by a mandatory tenant-scoped data-access layer **and** Postgres RLS as defense-in-depth. Not schema- or
   DB-per-tenant. (§2, §3)
2. **`Contact` becomes per-user** (`@@unique([userId, linkedinProviderId])`), plus a **new account-level
   contact-suppression** index so one shared sender identity never hits the same recipient for two users. (§3, §5)
3. **Auth:** Auth.js v5 + Prisma adapter (email/password + Google OAuth), DB sessions, `USER`/`ADMIN` roles;
   kill the shared password. (§4)
4. **LinkedIn pool service:** sticky user→account assignment, per-account **shared daily safety budget** split
   by a guaranteed-floor + weighted-burst scheme, per-account warmup, restriction→quarantine→reassign, and an
   honest **concierge sender persona** (the impersonation problem is otherwise unfixable in a shared pool). (§5, §6)
5. **Background execution:** replace the single global cron with a **durable queue fanned out per *account***
   (not per user) — parallelism naturally equals pool size (~29). Recommend **Inngest** (or QStash/pg-boss). (§7)
6. **Rate limiting:** two-level — **per-account safety budget** (shared) × **per-user plan quota** (fairness). (§6)
7. **LLM governance:** `LlmUsage` gets `userId`; pre-call budget check against a monthly plan cap with a
   graceful-degradation ladder. (§8)
8. **Billing:** Stripe, plan tiers mapped to caps (discovery/day, outreach/day, LLM $/mo, tailors/mo); outreach
   is a capacity-gated entitlement. (§11)
9. **Fix these audit gaps *as part of* this redesign** because they become multi-tenant safety/liability issues:
   per-account caps (E4), per-account distress-pause (E1), duplicate-DM idempotency index (E3/#7), relevance
   threshold (A1), FX-fail salary bypass (A3), resume truthfulness gate (C1–C3), settings validation (A5),
   SSRF (F2), email HTML injection + CAN-SPAM (F3), and resolve the blind-send gate (B1) into an explicit
   opt-in. (§15)

---

## 1. The critical tension, quantified: shared-pool throughput ceiling

The pool's binding constraint is **connection invites** (referral outreach is invite-heavy — 2nd/3rd-degree
recruiters must be invited before they can be DM'd). Direct DMs to accepted connections are a smaller,
downstream volume and are **not** the bottleneck.

### 1.1 Per-account safe invite budget

Today's config (`src/config.ts`): `dailyInviteCap: 10`, `weeklyInviteCap: 60`, `dailyDmCap: 3`, plus a warmup
ramp in `limits.ts` (5/day for 2 days → 8/day for 3 days → configured cap). The binding sustained rate is
`min(daily, weekly/7)` = `min(10, 8.57)` ≈ **8.5 invites/account/day** at the current settings. LinkedIn's real
tolerances vary by account age/quality; a defensible planning range:

| Posture | Invites/acct/day (sustained) | Notes |
|---|---|---|
| Conservative (≈ current config) | ~8.5 | weekly cap binds; lowest ban risk |
| Moderate | ~15 | aged, warmed accounts |
| Aggressive | ~20 | elevated restriction risk — not recommended for a shared pool |

### 1.2 Effective pool size

29 accounts is the **nameplate**, not the **available** count. Subtract warmup (new/replacement accounts run
at 5/day), quarantine (restricted accounts, see §5.4), and Unipile disconnects. Assume ~85% healthy →
**~25 effective accounts**.

### 1.3 Pool capacity and the user ceiling

```
pool_invites_per_day  = healthy_accounts × per_account_safe
active_outreach_users = pool_invites_per_day / per_user_daily_allocation
```

| | Conservative (8.5) | Moderate (15) | Aggressive (20) |
|---|---|---|---|
| **Pool invites/day (25 acct)** | ~213 | ~375 | ~500 |
| Users @ 10 invites/day each | **~21** | ~37 | ~50 |
| Users @ 5 invites/day each | ~43 | ~75 | **~100** |

**Honest ceiling: ~40–100 *concurrently-active outreach* users, and realistically ~20–40 if each user is to
make meaningful progress (10 invites/day).** This is independent of how many people sign up. To serve 1000s of
active-outreach users you would need **200–700 pooled accounts** — a large, ongoing, high-risk ops burden
(acquisition, warmup, phone/email per account, Unipile seat cost, correlated ban exposure) — or **BYO-LinkedIn**
(§5.6). DMs are not the constraint: even at today's stingy 3/day, 25 accounts ≈ 75 DMs/day; realistic messaging
tolerance is ~20–30/day/account (~500–750 pool-wide), always well above accepted-invite volume.

**Design consequence (drives §7, §11, §15):** treat outreach **activation** as a scarce, allocated resource.
Sell Plane A to everyone; put Plane B behind a **capacity gate** (waitlist + max-concurrent-active-users
derived from live pool health). Do not let signup imply an outreach slot.

---

## 2. Tenancy model

**Recommendation: single database, single schema, row-level `userId` on every tenant-owned table**, enforced
by (a) a mandatory tenant-scoped data-access layer in the app and (b) Postgres Row-Level Security as a backstop.

### 2.1 Why not the alternatives

| Model | Verdict at 100s–1000s users | Why |
|---|---|---|
| **Row-level `userId` (recommended)** | ✅ | Cheapest; one migration path; trivial cross-tenant admin/analytics/pool queries (the pool ledger is inherently cross-tenant); Supabase/Postgres RLS available as a backstop. Standard for B2C SaaS at this scale. |
| Schema-per-tenant | ❌ | 1000s of schemas = migration fan-out nightmare, catalog bloat, and the pool/rate-ledger tables are cross-tenant anyway. |
| DB-per-tenant | ❌ | Runtime already uses a **transaction pooler** (Supabase/PgBouncer) with a bounded connection budget; 1000s of DBs is operationally and financially untenable. Reserve only for a future enterprise tier. |

### 2.2 Tenant key: `userId` now, `orgId`-ready

For a self-serve individual job-seeker product, **the user *is* the tenant**. Use `userId` as the tenant key.
To make team/agency accounts a **non-breaking** future addition, add a nullable `orgId` column now (defaulting
to the user's own id); all scoping helpers key on an abstract `tenantId` that today resolves to `userId`.

### 2.3 The pooler caveat (must not be skipped)

RLS commonly relies on a per-request session variable (`SET app.current_user_id`). With PgBouncer in
**transaction** pooling mode (the current runtime `DATABASE_URL`), a plain `SET` leaks across pooled
connections. Two safe options:

- **Primary enforcement in the app** (recommended): a tenant-scoped Prisma layer (§3.4) that *cannot* issue an
  unscoped query. This is deterministic and pooler-agnostic.
- **RLS as backstop:** use `SET LOCAL app.current_user_id = ...` **inside a transaction** (survives transaction
  pooling) via a Prisma `$extends`/client-extension that wraps every query in a tx and sets the local GUC.
  Slight overhead; worth it as defense-in-depth on the highest-value tables. Migrations run on `DIRECT_URL`
  (unaffected).

---

## 3. Data model changes

### 3.1 Tables that get `userId` (tenant scoping)

Every currently-global tenant-owned table gains `userId String` + FK + composite indexes:

| Table | Change | Notes / index |
|---|---|---|
| `Job` | + `userId` | all existing indexes become composite: `@@index([userId, appStage])`, `([userId, dedupeKey])`, `([userId, company])`, `([userId, createdAt])` |
| `Contact` | + `userId`; **drop global unique** on `linkedinProviderId` → `@@unique([userId, linkedinProviderId])` | see §3.3 |
| `Outreach` | + `userId` (denormalized for scoping/fairness) | `@@index([userId, createdAt])` |
| `ChannelThread` | + `userId`; `accountId` already exists (now a real pool FK) | `@@index([userId, status])`, `@@index([accountId, status, nextActionAt])` (per-account claim, §7) |
| `ThreadMessage` | + `userId` (denormalized) | `@@index([userId, sentAt])`; and the **missing** `@@unique([threadId, providerMessageId])` (audit E3/#7) |
| `LlmUsage` | + `userId` | `@@index([userId, createdAt])`, `([userId, purpose])` — powers metering (§8) |
| `WebhookEvent` | keep global (provider dedup) | but resolve target thread → its `userId` on handling |
| `CronLock` | keep global; add per-account/per-user lock *names* (§7) | e.g. `enqueue:{userId}:{jobId}` |

### 3.2 Singletons → per-user

`AppSettings` and `ResumeProfile` stop being `id="default"`:

```
AppSettings   { userId String @id  data Json  updatedAt }     // one row per user
ResumeProfile { userId String @id  baseResumeKey ... masterTex whitelist altResumeKey ... }
```

`getSettings()`/`updateSettings()` (`src/lib/settings.ts`) change from `where:{id:"default"}` to
`where:{userId}` and the 60s process-wide cache becomes an **LRU keyed by `userId`** (a single-value cache
would leak one user's settings to another — a critical bug to avoid). `defaults()` still merges over
`config.ts` (which becomes **platform defaults**, no longer owner-specific).

`AiProvider` becomes platform-level by default (pooled keys, §8/§9) with an optional per-user BYO-key row
(`userId?`) for a future "bring your own OpenAI key" tier.

### 3.3 The `Contact.linkedinProviderId` global-unique problem

Today `Contact.linkedinProviderId @unique` means **one human = one global row**, with a single global
`lastContactedAt` cooldown. In multi-tenant this is wrong on two axes:

- **Two users must be able to target the same recruiter independently** (separate outreach, separate cooldowns,
  separate reply threads). → `Contact` is **per-user**: `@@unique([userId, linkedinProviderId])`.
- **But** the *sending identity* is a **shared pool account**. If user A and user B are both assigned account
  `LI-7`, and both target the same recruiter, that recruiter gets **two messages from the same LinkedIn person**
  carrying two different candidates' pitches — obvious spam, and a fast route to a restriction. So dedup must be
  **two-dimensional**:

  1. **Per-user recontact gate** (as today, moved to per-user): don't re-contact a person for the *same* user
     within `recontactCooldownDays`.
  2. **Per-account suppression gate (NEW):** a given pool **account** must not contact the same
     `linkedinProviderId` for *any* second user within a cooldown. Implement as a new table:

     ```
     AccountContactLog { accountId  linkedinProviderId  userId  contactedAt
                         @@id([accountId, linkedinProviderId]) }
     ```
     Before an invite/DM, check this table; if the account already touched that person recently (even for
     another user), **skip the target and pick another** from the candidate pool.

### 3.4 New tables

**Identity / auth (§4):** `User`, `Account` (OAuth), `Session`, `VerificationToken` (Auth.js standard shapes).

```
User { id  email(unique)  passwordHash?  name  role(USER|ADMIN)  emailVerified?
       stripeCustomerId?  createdAt  ...
       outreachStatus (NONE|WAITLISTED|ACTIVE|SUSPENDED)   // Plane-B capacity gate (§1, §11)
       automationOptInAt?                                   // explicit consent (§10, locked decision #4)
     }
```

**LinkedIn account pool (§5):**

```
LinkedInAccount {
  id                 // Unipile account_id
  displayName        // the concierge persona name shown to recipients
  status             ACTIVE | WARMING | QUARANTINED | DISCONNECTED | RETIRED
  warmupStartedAt
  dailyInviteCap     // per-account override (warmup/health-tuned)
  weeklyInviteCap
  dailyDmCap
  assignedUserCount  // denormalized for the balancer
  lastRestrictionAt
  quarantineUntil?
  createdAt updatedAt
}

AccountAssignment {           // sticky user → account binding (§5.2)
  userId  accountId  assignedAt  active(Boolean)
  @@unique([userId])          // one active sending identity per user
  @@index([accountId, active])
}

AccountRateLedger {           // per-account, per-UTC-day counters (replaces global counts, §6)
  accountId  day(Date)  invitesSent  dmsSent  updatedAt
  @@id([accountId, day])
}

AccountEvent {                // audit + ban monitor (§5.4, §12)
  id accountId type(RESTRICTED|RATE_LIMITED|WARMUP_STEP|DISCONNECTED|REASSIGNED)
  detail(Json) createdAt
}
```

**Billing / usage (§8, §11):**

```
Subscription { userId(@id)  stripeSubId  plan(FREE|STARTER|PRO|...)  status  currentPeriodEnd  ... }

UsageCounter {                // per-user, per-billing-period rollups (fast entitlement checks)
  userId  period(YYYY-MM)  llmCostCents  jobsDiscovered  invitesSent  dmsSent  tailorsRun
  @@id([userId, period])
}
```

`Plan` limits (caps) live in code/config as an entitlements map keyed by plan, cached; `UsageCounter` is the
metered side checked against it.

### 3.5 Cross-tenant leakage risks in the current queries (must all be fixed)

These are today's *global* reads/writes that will leak or corrupt across tenants unless scoped:

- **Discovery** (`app/api/cron/discover/route.ts`): every `prisma.job.create/update/findMany` (dedup, digest
  `openBoard`, staleness) is global → must be `userId`-scoped; discovery itself becomes **per-user** (§7).
- **Send budget** (`src/outreach/limits.ts`): `channelThread.count`/`threadMessage.count` are **pool-wide
  global** → must become **per-account** (`AccountRateLedger`) and additionally **per-user** (quota). This is
  audit **E4** ("rate caps are global") turned from a latent issue into a hard blocker.
- **Claim CTE** (`src/outreach/outreach-tick.ts` `claimDueThreads`): partitions by `jobId` across **all
  threads globally** → must partition **within (account, user)** and respect per-account budget (§7).
- **Distress pause** (`src/outreach/safety.ts`): `settings.outreach.globalPause` is one global flag → a single
  restricted account would pause **every** user. Must become **per-account** quarantine (audit E1). 
- **Reconcile / poll** (`reconcileInviteAcceptances`, `pollReplies`): hardcode `config.owner.linkedinAccountId`
  and a single daily `WebhookEvent` marker → must iterate **per account**, with per-account day markers.
- **Settings cache** (`getSettings`): single-value module cache → per-`userId` LRU (§3.2).
- **Resume/S3**: `resumeProfile.update({where:{id:"default"}})` in `alt-identity.ts`/`pipeline.ts` → per-user
  keys (§9).
- **Contact upsert** (`enqueue.ts`): `where:{linkedinProviderId}` → `where:{userId_linkedinProviderId}`.

---

## 4. Auth & identity

**Recommendation: Auth.js (NextAuth v5) with the Prisma adapter.** It fits the existing Next.js App Router +
Prisma stack, owns the `User`/`Session`/`Account` tables in *our* DB (needed for pool assignment and Stripe
linkage), and avoids a second identity SoT. (Clerk/WorkOS are viable managed alternatives if you want to buy
rather than build; Supabase Auth is possible but keeping identity in Prisma is cleaner given how much of the
domain model FKs to `User`.)

**Included:**
- **Providers:** email+password (Argon2id/bcrypt hash) and Google OAuth. Email verification required before
  Plane B (outreach). Password reset via the existing SMTP (nodemailer).
- **Sessions:** DB-backed sessions (rotating, httpOnly, `Secure`, `SameSite=Lax`); short access + refresh.
- **Roles:** `USER`, `ADMIN` (admin console §12). Optional `SUPPORT` later.
- **Kill the shared password** in `middleware.ts`. Cron/webhook auth stays secret-based but move both compares
  to **constant-time** (`crypto.timingSafeEqual`) — audit **F1**.

**Tenant-scope enforcement (the part that prevents data leaks):**

1. **Middleware** resolves the session → `userId`, rejects unauthenticated app/API requests, and attaches
   `userId` to a request-scoped context.
2. **Mandatory data-access layer.** Route handlers **never** import `prisma` directly. They call
   `db(userId)` → a thin wrapper that returns tenant-scoped repository functions; each injects
   `where:{ userId }` and stamps `userId` on writes. Enforce with an ESLint rule banning `@/lib/prisma`
   imports outside `src/data/**` and the pool/admin modules. A missing filter becomes a *compile-time/lint*
   error, not a runtime leak.
3. **RLS backstop** on the highest-value tables (`Job`, `Contact`, `Outreach`, `ChannelThread`,
   `ThreadMessage`, `LlmUsage`, `AppSettings`, `ResumeProfile`) via `SET LOCAL` inside a transaction (§2.3),
   so even a bug in (2) cannot cross tenants.
4. **Object-level checks:** any `:id` route (`/api/jobs/[jobId]`, resume download, outreach confirm) verifies
   `row.userId === session.userId` (prevents IDOR). Presigned S3 URLs are minted only after that check (§9).

---

## 5. LinkedIn account pool service

A dedicated internal service (`src/pool/*`) owning assignment, budgets, warmup, health, and reassignment. It is
the only module that maps a `userId` → a Unipile `accountId`, replacing every `config.owner.linkedinAccountId`
reference (`thread-worker.ts:240`, `people-finder.ts:313`, `replenish.ts:58`, reconcile/poll).

### 5.1 The impersonation problem — confront it first (ethics/ToS/legal)

The locked decision is a **shared** pool, not BYO. That forces an integrity question the current templates get
wrong. Today `firstDm` says *"I'm currently working as a Software Engineer at Salescode.ai…"* — the **job
seeker's** identity — but it will be sent from a **pool LinkedIn account that is a different real person**. From
the recipient's chair: a stranger's LinkedIn profile messages them claiming to be someone else. That is
**deceptive**, it violates LinkedIn's User Agreement (§8.2 prohibits automation, fake/misrepresented identity,
and scraping), and — because replies land in the pool account's inbox, not the candidate's — it also breaks the
product.

**Only defensible framing in a shared pool: a "concierge" persona.** The pool accounts are branded, real,
consistent assistant identities (e.g., *"{Name} — Talent Concierge @ {Platform}"*), and messages are written
in the **third person on behalf of** the candidate: *"Hi — I help candidates find referrals; I'm reaching out
for Anand, a backend engineer (Java/Spring)… would you be open to referring them for {role}?"* This is honest
about who is sending, keeps replies routable to the right candidate (the persona forwards/relays), and is the
model recruiting agencies already use. **Costs to acknowledge honestly:** lower response rates than a
peer-to-peer message; it is still **automation**, which LinkedIn's ToS forbids regardless of framing; and it
still requires consent language and unsubscribe handling on the recipient side. **This does not make shared-pool
outreach ToS-compliant — it makes it *not-fraudulent*.** The genuinely compliant/high-integrity path is
**BYO-LinkedIn** (§5.6), which should be the documented target state. Product/legal must sign off on operating
Plane B at all; the architecture supports turning it off per-region/per-plan.

### 5.2 Assignment algorithm

- **Sticky, 1 active account per user** (`AccountAssignment @@unique([userId])`). Sticky because a thread's
  invite and its later DM/followup **must** come from the same LinkedIn identity (`ChannelThread.accountId` is
  already sticky per thread — good foundation). One identity per user keeps that user's whole outreach coherent
  and keeps replies in one inbox.
- **Assign on outreach-activation** (not signup): when a user is promoted from `WAITLISTED`→`ACTIVE`, pick the
  **least-loaded healthy** account: minimize `assignedUserCount`, tie-break on lowest recent restriction rate
  and most remaining budget today. Cap `assignedUserCount` per account (e.g. ≤ `floor(daily_cap / guaranteed_floor)`
  from §1.3) so the account is never oversubscribed past its fair-share math.
- **Multiple users per account share that account's daily budget** (§6). The concierge persona makes this
  acceptable (one persona legitimately serves many candidates); the two-dimensional dedup (§3.3) prevents the
  same recipient being hit twice by one persona.

### 5.3 Per-account warmup

Generalize the existing warmup ramp (`limits.ts`) from a **global** first-invite age to **per-account**
(`LinkedInAccount.warmupStartedAt`): 5/day (days 0–1) → 8/day (days 2–4) → configured cap. New and
replacement accounts enter `WARMING`; the balancer prefers `ACTIVE` accounts and only routes overflow to
`WARMING` within their reduced cap. A dedicated **warmup queue** (a worker task) can also drive gentle
self-activity to age accounts before they carry user load.

### 5.4 Restriction detection, quarantine, reassignment

Signals (extend `UnipileError` handling in `client.ts`/`safety.ts`): HTTP 429 (transient), `account_restricted`
/ `limit_exceeded` / `disconnected` (hard), and derived signals (elevated invite-rejection rate, a spike in
`consecutiveFailures` across that account's threads).

```
on transient (429):  mark account RATE_LIMITED, back off (quarantineUntil = now + cooldown),
                     ABORT this account's tick batch (fix audit E1), auto-resume after cooldown.
on hard (restricted): status = QUARANTINED; record AccountEvent; alert admin;
                     FREEZE in-flight threads on this account (can't send from a restricted acct);
                     REASSIGN affected users to a healthy account for FUTURE outreach;
                     do NOT migrate in-flight threads (their invites live on the old identity).
```

**Honest degradation:** a user whose account is quarantined has their **pending referrals stall** (an invite
sent from account A can only be followed up from A). New outreach flows to the reassigned account; the old
threads wait for A to recover or time out. This is inherent to shared-pool + sticky-identity and must be
surfaced to the user ("your outreach is briefly paused while we move you to a new sender").

### 5.5 Contact-pool isolation

`Contact` is per-user (§3.3). Two users targeting the same person keep independent threads, cooldowns, and
reply state. The **account-level** `AccountContactLog` prevents one persona double-touching a recipient across
users. `people-finder.ts` gains a pre-filter: drop candidates already in `AccountContactLog` for the assigning
account within the cooldown, then top up from the wider candidate pool.

### 5.6 Pool scaling & the BYO migration path

- **Scale the pool:** linear and operationally heavy. Each new account needs a real LinkedIn identity, a phone
  + email, a Unipile seat, and 1–2 weeks of warmup. Build an **account-onboarding runbook + a
  provisioning/warmup pipeline**, and monitor **restriction rate per cohort** (correlated bans are the risk —
  many users behind few accounts). Realistic target: grow to ~50–75 accounts; past that the ops/ban math gets
  ugly (see §1).
- **BYO-LinkedIn (documented target state):** Unipile already supports connecting a user's own account via a
  hosted auth flow. The schema is BYO-ready: `LinkedInAccount` can be owned by a `userId` and `AccountAssignment`
  points a user at their own account instead of a pool one; per-account budgets/warmup/quarantine all apply
  unchanged. BYO removes the ceiling **and** the impersonation problem (the user sends as themselves, with
  consent), at the cost of each user's own ban risk. Recommend: offer BYO as a **Pro tier** as soon as feasible;
  keep the pool as the zero-setup default for lower tiers within the capacity gate.

---

## 6. Rate limiting & send scheduling

Convert the single global counter into a **two-level** check. A send proceeds only if **all** hold:

```
canSend(user, account, kind) =
      account.status == ACTIVE
  AND withinSendWindow(user.timezone, user.settings)      // per-user window, not one global IST window
  AND ledger(account, today).<kind>Sent < account.<kind>Cap(warmup-adjusted)   // ACCOUNT safety (shared)
  AND usage(user, period).<kind>Sent  < plan(user).<kind>Cap                    // USER fairness/plan quota
  AND NOT account.quarantined
  AND NOT user.suspended
```

- **Account budget (safety, shared):** authoritative counter is `AccountRateLedger(accountId, day)`, atomically
  incremented on each successful send (replaces the global `channelThread.count`/`threadMessage.count` in
  `limits.ts`). Rolling-24h semantics can be preserved by summing today+partial-yesterday, or simplified to
  UTC-day buckets keyed to the account — the ledger row makes either cheap.
- **User quota (fairness, plan):** `UsageCounter(userId, period)` for monthly plan caps, plus a per-user daily
  slice so no single user drains a shared account's day. **Fair-share within an account:**

  ```
  guaranteed_floor = floor(account_daily_cap / assignedUserCount)     // every user gets at least this
  burst_pool       = account_daily_cap - Σ(floors already used today) // leftover shared by weighted round-robin
  user_daily_alloc = guaranteed_floor + weighted_share(plan_weight, burst_pool)
  ```

  Higher plans get a heavier `plan_weight` for burst; everyone keeps their floor. This is enforced in the claim
  step (§7): the per-account tick round-robins across that account's users, honoring each user's remaining alloc
  and the account's remaining budget.
- **Manual "send now"** (the `sendForJobs` bypass in `outreach-tick.ts`) may bypass the **user** daily pacing
  but must **never** bypass the **account safety** budget (today it bypasses the global caps — acceptable for a
  personal single account, dangerous when the account is shared). Cap manual bursts against `AccountRateLedger`.
- **Send window** becomes **per-user timezone** (stored on `User`), replacing the hardcoded Asia/Kolkata math in
  `limits.ts`.

---

## 7. Background execution at scale

**Problem:** one Vercel cron invocation (`/api/cron/tick`, 60s, `MAX_PER_TICK=15`) cannot run per-user for
1000s of users, and the current claim CTE scans all threads globally. **The natural unit of parallelism is the
*account*, not the user** — because the account budget is the real constraint and each account must be driven
single-threaded to keep its send pacing coherent.

**Recommendation: a durable queue + workers, fanned out per account.** Preferred: **Inngest** (serverless-native
on Vercel, durable steps, per-key concurrency + throttling, retries, idempotency keys built in). Alternatives:
**Upstash QStash** (simple HTTP scheduler+queue) or **pg-boss** on a small dedicated worker (Fly.io/Render) if
you'd rather not add a vendor. SQS + a container worker is the heavier "big-co" option.

### 7.1 Topology

```
                    ┌─────────────── scheduler (cron, every N min) ───────────────┐
                    │  reads healthy accounts + due work; emits one event/account   │
                    └───────────────────────────────┬───────────────────────────┘
                                                     │ fan-out
        account.tick(LI-1)   account.tick(LI-2)  …  account.tick(LI-25)
        (concurrency key = accountId, limit 1)  ← at most ~25 in flight (= pool size)
                    │
                    ├─ load AccountRateLedger(today) → remaining invite/dm budget
                    ├─ claim due threads for THIS account, round-robin across its users
                    │  honoring per-user alloc (§6); ORDER as today (post-accept first,
                    │  then per-(user,job) rank, then score) but scoped to the account
                    ├─ for each: processThread(...) with idempotency key
                    └─ atomic ledger increments on success

  discovery.forUser(userId)   ← separate fan-out, per user, throttled; charges LLM to user (§8)
  poll.account(LI-x)          ← per-account reply/acceptance reconcile (replaces global reconcile)
```

- **Fan-out bounded by pool size (~25)**, which *matches the real constraint* — you never need 1000-way
  parallelism for outreach because the pool can't send that fast anyway. Discovery fan-out is per-user but
  throttled by a concurrency key and by LLM budget.
- **Idempotency:** every send carries an idempotency key (`threadId:phase:attempt`); combined with the new
  `@@unique([threadId, providerMessageId])` (audit E3) and the existing `pendingSendKey` crash-marker, this
  eliminates duplicate DMs. Inngest/QStash dedup keys make retries safe.
- **Serialization:** replace `withCronLock("tick")` (one global lock) with **per-account** locks/concurrency
  keys (`tick:{accountId}`), so accounts run independently but each account stays single-threaded.
- **Discovery:** move off the single daily global run to **per-user scheduled discovery** (cadence per plan),
  each run scoped to that user's `AppSettings`, charging LLM to that user and stopping at the user's LLM cap
  (§8). Batch/stagger to smooth OpenAI rate limits and cost.

### 7.2 Cost

Inngest/QStash pricing is per-step/per-message and modest at this scale (tens of thousands of steps/day for a
~25-account pool + per-user discovery). A self-hosted pg-boss worker is a fixed ~$10–25/mo box. Either is far
cheaper than the LLM and Unipile line items. Vercel functions remain for the web app + webhook receivers.

---

## 8. LLM cost governance

`LlmUsage` already logs **one row per successful completion** with `model`, `purpose`, and token counts
(`src/ai/ai-adapter.ts:88`). The gap is only tenancy + enforcement (audit **F4**: no spend cap anywhere).

- **Meter per user:** add `userId` to `LlmUsage`; the adapter stamps it from the call context. Roll up into
  `UsageCounter.llmCostCents` per billing period using a **model→price** table (input/output $/1K tokens),
  centralized so pricing changes don't touch call sites.
- **Hard cap (pre-authorization):** before an LLM call, `assertLlmBudget(userId, estTokens)` checks
  month-to-date spend vs the plan cap. Over cap → throw a typed `QuotaExceeded`, caught by callers to degrade,
  not crash. Because scoring/tailoring run in bulk during discovery, check the budget **per batch** and stop the
  run cleanly when exhausted (persist what's done; audit-style resumability).
- **Graceful degradation ladder** (as the user approaches/hits the cap):
  1. Drop resume auto-tailoring (`enableResumeTailoring=false` for the run) — highest token cost, lowest per-job value.
  2. Triage-only: run the cheap `triageModel` and skip full flagship scoring; mark jobs `NEW (unscored)`.
  3. Pause discovery for the period; keep the dashboard/outreach on already-scored jobs.
  4. Notify the user + upsell.
- **Tie to plan tiers** (§11): each plan carries an `llmMonthlyCents` cap; overage either hard-stops (FREE/
  STARTER) or bills as metered usage (PRO). Guardrails: per-run and per-day sub-caps to stop a single runaway
  loop (e.g. a pathological JD) from burning a month's budget in an hour.

---

## 9. Secrets, storage & config isolation

- **Per-user settings/resume:** covered in §3.2 (`AppSettings`/`ResumeProfile` keyed by `userId`; per-user
  settings cache).
- **S3 key namespacing:** prefix **every** object with the tenant: `u/{userId}/resume/base/…`,
  `u/{userId}/resume/jobs/{jobId}/tailored-*.pdf`, `u/{userId}/resume/alt/…`. Update `alt-identity.ts` and
  `pipeline.ts` (currently `resume/jobs/{jobId}/…`, `resume/alt/…`). Enforce isolation with an **IAM policy /
  bucket prefix condition** and by minting presigned URLs **only** after the object-ownership check (§4.4).
  Consider per-tenant KMS later; not needed for MVP.
- **Provider/platform secrets:** the pooled OpenAI key, Unipile key, SMTP creds, S3 creds, Stripe keys live in
  the platform **secret manager / env** (Vercel envs or a vault) — never in the DB. Fix `AiProvider.apiKey`
  being stored plaintext (audit): for the pooled model, don't store it in a table at all; for a future BYO-key
  tier, encrypt at rest (envelope encryption) and scope by `userId`.
- **Config isolation:** `config.ts` demotes from "the owner's settings" to **platform defaults + plan
  definitions**. Owner-specific values (keywords, salary floor, resume summary, friend digest, alt identity)
  become per-user `AppSettings`/`ResumeProfile` data. `config.owner.*` is deleted.

---

## 10. Security / privacy / compliance

- **Tenant isolation:** §2–§4 (data-access layer + RLS + IDOR checks + S3 prefixing).
- **Scraped-contact PII (the sharp GDPR edge):** `Contact` rows are **third parties who never signed up**.
  Establish a lawful basis (legitimate interest for professional-referral outreach, documented + balancing
  test), a **retention limit** (auto-purge contacts with no engagement after N days), honor **DSAR /
  right-to-erasure** from a recipient ("stop contacting / delete my data"), and record source + consent posture.
  Add a suppression list (recipients who opted out — global across the pool). This is materially more exposure
  than a personal tool and needs legal review before Plane B goes commercial in the EU/UK.
- **Data deletion & export (tenant):** account deletion cascades all `userId`-scoped rows + S3 objects (+ cancel
  in-flight outreach, release the account assignment) within the statutory window; provide a self-serve **data
  export** (JSON + resume files). Cascades are trivial thanks to row-level `userId`.
- **LinkedIn ToS & automation policy:** §5.1 — automation is prohibited by LinkedIn's User Agreement regardless
  of framing; the concierge persona makes it non-deceptive but not compliant. Operate Plane B as an explicit,
  consented, rate-limited, human-persona service; keep a kill switch (per-account, per-region, global); pursue
  BYO to shift identity/consent to the user. **Product + legal sign-off required.**
- **Email compliance:** the **friend digest** currently emails third parties unsolicited (audit context) — for
  a commercial product that is a CAN-SPAM/GDPR problem. Require **double opt-in** for any digest recipient,
  include a working **unsubscribe** link + physical mailing address in every non-transactional email, honor
  unsubscribes globally, and separate transactional (reply alerts, receipts) from marketing. Fix the unescaped
  HTML/`href` interpolation (audit **F3**) — it's a content/link-injection vector now that inputs are
  multi-tenant and attacker-controllable.
- **Abuse prevention:** email verification + disposable-domain blocklist at signup; per-IP/per-account signup
  and API rate limits; bot/CAPTCHA on signup; watch for the platform being used to spam (per-user outreach
  anomaly detection feeding suspension). SSRF fix (audit **F2**) in `url-ingest` — block internal/metadata IP
  ranges, disallow redirects to private ranges, and gate the third-party `r.jina.ai` egress.
- **DoS / rate-limit:** edge rate-limiting on auth and mutation endpoints; queue backpressure (§7); LLM and
  outreach caps double as cost-DoS protection.

---

## 11. Billing (Stripe)

**Model:** Stripe subscriptions with plan-mapped entitlements, plus metered LLM overage on the top tier.
Outreach is a **capacity-gated** entitlement, not a pure paywall (§1).

| Plan | Discovery | Resume tailors | LLM $/mo | Outreach (Plane B) | Price posture |
|---|---|---|---|---|---|
| **Free / Trial** | limited (e.g. 20 scored jobs/day, 7 days) | 0–2 | small hard cap | **off** | acquisition |
| **Starter** | daily discovery | N/mo | moderate hard cap | **waitlisted** invites (low daily alloc when activated) | entry |
| **Pro** | priority discovery | high | high cap **+ metered overage** | activated (higher alloc + burst weight); **BYO-LinkedIn option** | core |
| **(Future) Team** | org-shared board | pooled | pooled | multiple seats/accounts | expansion |

- **Entitlements** = a code-defined map `plan → { jobsPerDay, tailorsPerMonth, llmMonthlyCents, invitesPerDay,
  outreachEligible }`, cached; checks read `UsageCounter` (§8) vs this map.
- **Metering:** report LLM overage (Pro) to Stripe via metered usage records from `UsageCounter`; outreach and
  discovery are gated by caps rather than billed per-unit.
- **Webhooks:** Stripe → update `Subscription.status`/`plan`/`currentPeriodEnd`; on activation, if outreach is
  eligible and capacity exists, promote `outreachStatus` and trigger account assignment (§5.2); if not, enqueue
  to the waitlist.
- **Dunning:** Stripe Smart Retries + a grace period; on final failure, downgrade to Free (disable Plane B,
  keep data read-only), email the user. Never hard-delete on payment failure.

---

## 12. Onboarding flow

```
1. Sign up (email+password or Google)  → create User, Subscription(FREE)
2. Verify email                         → unlock Plane A
3. Profile & prefs                      → keywords, location, salary floor, target roles, timezone → AppSettings
4. Resume                               → upload master .tex or PDF; derive whitelist; compile preview → ResumeProfile
5. Choose plan (or stay Free)           → Stripe checkout; set entitlements
6. First discovery run (Plane A)        → per-user discovery job; digest + board populated
7. Outreach opt-in (Plane B, default OFF)→ explicit consent screen (what it does, whose identity sends,
                                           caps, ToS/risk disclosure) → automationOptInAt set
8. Account assignment                    → if capacity: assign pool account, outreachStatus=ACTIVE;
                                           else: outreachStatus=WAITLISTED (Plane A keeps working)
9. Outreach begins                       → within per-user caps + send window + account budget
```

Step 7 preserves the current auto-send behavior as an **explicit, consented opt-in** (locked decision #4):
default OFF, strong caps, clear disclosure. This is also where the audit's **B1 blind-send** ambiguity gets
resolved for the commercial product (§15).

---

## 13. Observability & ops

- **Per-tenant structured logging:** every log line and error carries `userId` (and `accountId` where
  relevant). Replace `console.*` with a structured logger + a tenant/account tag; ship to a log platform.
- **Metrics (per-tenant + per-account):** discovery volume, LLM spend, invites/DMs sent, accept/reply rates,
  per-account restriction rate, queue depth/lag, send-window utilization, pool utilization vs ceiling (§1).
- **Alerting:** account restricted/disconnected, pool utilization > threshold (approaching the ceiling),
  correlated-ban spike, user near/over LLM cap, dunning failures, queue backlog, discovery error rate (the
  existing `sendScoringFailureAlert` generalizes to per-user).
- **Admin console (new, ADMIN role):**
  - **Pool health board:** each account's status, warmup stage, today's budget vs used, assigned users,
    recent `AccountEvent`s, restriction history; manual quarantine / retire / reassign controls.
  - **Ban monitor:** restriction rate by account and cohort; one-click quarantine + bulk reassign.
  - **Per-user usage:** plan, LLM spend, outreach counts, outreach status, suspend/reactivate.
  - **Capacity dashboard:** live ceiling vs active users; waitlist length; promote-from-waitlist control.
  - **Support impersonation** (audited, consent-gated) for debugging a tenant.

---

## 14. Migration plan (single-tenant → multi-tenant, non-breaking)

Use the **expand → migrate → contract** pattern so the running app never breaks. The current owner becomes
**user #1** and all existing data is backfilled to them.

**Phase 0 — Expand schema (nullable), seed owner.**
- Create `User` (+ Auth.js tables); insert **user #1** from `config.owner` (email, name), role `ADMIN`.
- Add **nullable** `userId` to `Job`, `Contact`, `Outreach`, `ChannelThread`, `ThreadMessage`, `LlmUsage`.
- Add the new pool/billing/usage tables (empty).
- Deploy — nothing reads the new columns yet.

**Phase 1 — Backfill + flip singletons.**
- `UPDATE … SET userId = <owner>` on all tenant rows (batched).
- Migrate `AppSettings id="default"` → `AppSettings(userId=<owner>)`; same for `ResumeProfile`.
- Migrate `Contact` unique: drop global `@unique(linkedinProviderId)`, add `@@unique([userId, linkedinProviderId])`.
- Add the `@@unique([threadId, providerMessageId])` idempotency index (audit E3).
- Re-key S3 objects under `u/{owner}/…` (copy-then-swap, lazy on read is acceptable).
- Backfill `LinkedInAccount` from the current Unipile workspace (~29 accounts, statuses set); create the
  owner's `AccountAssignment` to their current account; seed `AccountRateLedger` from recent send history.

**Phase 2 — Enforce scoping.**
- Introduce the tenant-scoped data-access layer; migrate all routes/crons off raw `prisma` to `db(userId)`.
- Make `userId` **NOT NULL** on all tables (contract step) once backfill is verified.
- Enable RLS backstop on high-value tables.
- Per-user `getSettings` cache; per-user S3 prefixes enforced.

**Phase 3 — Auth cutover.**
- Ship Auth.js; keep the shared-password path behind a flag for the owner during transition, then remove it and
  the plaintext-compare in `middleware.ts`; move cron/webhook secrets to constant-time compare.

**Phase 4 — Pool service + queue.**
- Stand up `src/pool/*` (assignment, per-account budgets/warmup/quarantine); replace every
  `config.owner.linkedinAccountId`.
- Convert rate accounting to `AccountRateLedger` + `UsageCounter`; per-account distress/quarantine (retire the
  single `globalPause`).
- Introduce the durable queue + per-account fan-out; retire the single global cron tick (keep discovery as
  per-user scheduled jobs).

**Phase 5 — Commercialize.**
- Stripe + entitlements; onboarding flow; outreach opt-in + waitlist/capacity gate; friend-digest double-opt-in
  + unsubscribe; admin console; observability.

Each phase is independently deployable and reversible; the app stays live throughout (the owner runs on the new
schema from Phase 1 onward).

---

## 15. Audit gaps: fix in this redesign vs defer

A redesign is the moment to fix the **systemic** gaps — several become multi-tenant **safety, cost, or
liability** issues rather than personal annoyances. References are to `docs/audit-2026-07-08.md`.

**Fix now (they are load-bearing for multi-tenant safety):**

| Audit | Why it becomes critical multi-tenant | Where it lands here |
|---|---|---|
| **E4** global rate caps | A shared account with global counters can't fairly or safely serve many users | §6 (per-account ledger + per-user quota) |
| **E1** distress-pause is global & doesn't abort batch | One restricted account would pause **all** users; batch keeps hammering a restricted acct | §5.4, §7 (per-account quarantine + abort) |
| **E3 / #7** duplicate DMs, inert idempotency (no unique index) | At scale, retries/queue redelivery → duplicate DMs from a shared persona (spam → bans) | §3.1/§7 (`@@unique([threadId, providerMessageId])` + idempotency keys) |
| **A1** relevance threshold not enforced | Mass mis-scored auto-outreach from shared accounts → reputational + ban risk across tenants | §8 discovery hardening (enforce `score < threshold ⇒ skip`) |
| **A3** FX outage silently disables salary floor | Same mass-auto-outreach vector, now multiplied across users | discovery hardening (treat FX failure as "don't pass") |
| **C1–C3** resume truthfulness gate bypassable | Platform would be **facilitating résumé fabrication** for paying users → legal/reputational liability | must fix before commercial resume tailoring (span-scoped edits, no imported tokens/numbers) |
| **A5** settings PATCH unvalidated | Settings are now **untrusted user input**; a bad patch crashes that user's discovery | validate + bound all settings writes in the data layer (§4) |
| **F1** shared password / non-constant-time compares | Replaced wholesale by real auth | §4 |
| **F2** SSRF in url-ingest, **F3** email HTML/link injection | Multi-tenant, attacker-controlled inputs + emails to third parties | §10 |
| **B1** "never blind-send" gate is false | For a commercial product, unreviewed auto-send from shared accounts is unacceptable | resolve as **explicit opt-in** (§10, §12) matching locked decision #4; delete stale dead code (confirm route/draft sweep) or restore a real gate — pick one and make code+docs consistent |
| **E2** invite-timeout clobbers live threads | Data-integrity bug that worsens with per-account reassignment/freezing | fix guard (don't archive on transient fetch failure; guard REPLIED/CONNECTED) |

**Defer (fix soon, not blockers for the multi-tenant cutover):**

- **E5** analytics funnel inflated by unsent connections — cosmetic; matters for per-user dashboards, fix in the
  analytics pass, not the migration.
- **D1/D2** Adzuna/JSearch salary scaling & currency defaults — correctness bugs; fix in a source-adapter pass.
- **D3/D4/D5** friend-digest salary display, unknown-post collisions, dedupe truncation — fix alongside the
  friend-digest opt-in rework (§10).
- **C4/C5** tailor retry-after-failure, tailor locks, alt-PDF reconcile — reliability polish for the resume
  service; fix when Plane A tailoring is hardened (before charging for it, but not gating the tenancy work).
- **G1–G3** staleness/stage-transition edge cases — after core scoping.

---

## 16. Open risks & honest limits

1. **The shared-pool ceiling is real and low (~40–100 active-outreach users; §1).** No amount of software
   removes it. Mitigations: split the product (Plane A vs B), gate outreach with a waitlist/capacity dashboard,
   grow the pool to ~50–75 accounts, and push BYO-LinkedIn as the true escape hatch. **Do not market
   "automated outreach for everyone" — market Plane A broadly and Plane B as a limited, opt-in add-on.**
2. **Shared-account impersonation is an integrity ceiling, not a bug (§5.1).** The concierge persona makes it
   *non-deceptive*; it does **not** make it LinkedIn-ToS-compliant. This needs explicit product + legal sign-off,
   a kill switch, and a BYO roadmap. Be honest with users about whose identity sends their outreach.
3. **Correlated ban risk.** Many users behind few accounts means one bad pattern can restrict an account that
   was serving dozens of users at once. Per-account warmup, conservative caps, per-account distress handling,
   and cohort ban-rate monitoring are mandatory, not optional.
4. **Unipile is a single point of failure and a per-seat cost** that grows with the pool; the whole of Plane B
   depends on it. Have a degradation plan (pause Plane B cleanly; Plane A unaffected).
5. **Pooled LLM cost is unbounded without the §8 caps.** The pre-call budget check and degradation ladder are
   load-bearing for unit economics, not nice-to-haves.
6. **GDPR exposure from scraped third-party contact PII (§10)** is materially larger than a personal tool and
   needs legal review before EU/UK commercial launch.

### Phased roadmap (MVP → scale)

```
MVP (Plane A, monetizable, unbounded):
  auth · row-level userId + data layer · per-user settings/resume/S3 · per-user discovery+scoring+tailoring
  · per-user LLM metering & caps · Stripe (Free/Starter/Pro) · digests (opt-in) · dashboard
  → sell to everyone; NO outreach yet (or owner-only)

V1 (Plane B, capacity-gated):
  pool service (assignment/budgets/warmup/quarantine) · per-account fan-out queue · two-level rate limits
  · concierge persona + two-dimensional dedup · outreach opt-in + waitlist · admin pool console · observability
  → outreach for the first ~40–100 activated users

V2 (scale & integrity):
  BYO-LinkedIn (Pro) — removes the ceiling and the impersonation problem · pool grown to ~50–75 · Team tier
  (orgId) · metered LLM overage · fuller compliance (DSAR automation, suppression lists, regional kill switches)
```

**Bottom line:** the tenancy conversion is straightforward row-level `userId` work; the hard, non-negotiable
truth is the **outreach pool ceiling and its integrity constraints**. Architect for that reality — two planes,
capacity-gated outreach, an honest sender persona, and a BYO exit — and the SaaS is genuinely buildable. Pretend
the pool scales to 1000s and it will get accounts banned and users misled.
