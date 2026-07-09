# Job-Seeker → Commercial SaaS: The Build Plan

**Date:** 2026-07-09 · **Status:** Actionable, sequenced · **Builds on:** `multi-user-architecture-FINAL.md`
**This doc is the "how we get there" companion to FINAL's "what it should be."** No UI design — architecture and sequencing only.

## How this differs from the FINAL doc (three locked decisions)

FINAL was written for 100s–1000s users with a 29-account concurrent pool. Three product decisions (2026-07-09) reshape the build:

| Decision | Effect on the plan |
|---|---|
| **Start at ~5 users, grow later** | Most red-team scale concerns (C1 scrape ceiling, C2 quadratic LLM cost) are *negligible at 5 users*. We still adopt the **shared-corpus / per-user-match** shape because it's the correct foundation and no harder to build — but we **defer** RLS, pool-fairness math, org/team tier, and aggregate circuit breakers to a later phase (§7). |
| **Two tiers only: Free + Paid** | Free = the **digest product** (READ + cheap MATCH, email only). Paid = **everything** (dashboard, flagship scoring, salary, tracking, tailoring, outreach). Entitlement is a single boolean-ish gate, not a feature matrix. |
| **Outreach = serial rotation through 1 UniPile seat** | The SEND subsystem is **not** a parallel per-account pool. It's **one active LinkedIn account at a time**, swapped through the single seat by a Playwright session manager. This *simplifies* concurrency (no cross-account fan-out) but adds a **rotation/challenge-solving subsystem** (§6) and makes **throughput the binding constraint**. Persona + relay-inbox (FINAL C5/D2) are still required — the sending account is a pool persona, never the user's own. |

Everything else from FINAL stands: row-level `userId`, data-access layer as primary isolation, shared `Job` corpus, webhook routing scoped by `account_id`, migration expand→backfill→contract.

---

## 1. The product, mapped to the three planes

| | **Free** | **Paid** |
|---|---|---|
| Signup + resume upload | ✅ | ✅ |
| Auto-profile from resume | ✅ | ✅ |
| Per-user settings (salary floor, roles, locations) | ✅ | ✅ |
| **READ** — shared job discovery | shared corpus (once, global) | same shared corpus |
| **MATCH** — relevance | cheap **triage** model only | full **flagship** scoring + reasons + salary intel |
| Delivery | **personalized email digest** | digest **+ web dashboard / board** |
| Application tracking (stages, pin, skip) | ❌ | ✅ |
| **Resume tailoring** (per-job LaTeX) | ❌ | ✅ |
| **SEND** — automated referral outreach | ❌ | ✅ (opt-in, serial rotation) |
| Reply relay inbox | ❌ | ✅ |

**Cost shape that justifies the wall:** Free costs only a slice of one shared discovery run + one cheap triage call per matched job. Paid adds flagship LLM per unique job, LaTeX compile, and (for outreach users) a share of the UniPile seat + rotation ops. This is why flagship scoring, tailoring, and outreach are all Paid — they're the variable-cost lines.

---

## 2. Target data model (the concrete deltas)

The current schema is hard single-tenant: `ResumeProfile`/`AppSettings` are `id:"default"` singletons, and `Job` carries **owner-specific pipeline state** (appStage, pinned, skipSource, outreachState, tailored*, directAppliedAt, referredAt). The conversion is: **split `Job` into a shared corpus + a per-user join, and per-user-ify the singletons.**

### New (identity & billing)
```
User            { id, email @unique, name?, emailVerifiedAt?, tier FREE|PAID,
                  status ACTIVE|SUSPENDED, createdAt }
Account/Session/VerificationToken            // Auth.js v5 Prisma adapter tables
Subscription    { userId @unique, stripeCustomerId, stripeSubId?, tier,
                  status, currentPeriodEnd? }   // Phase 2
```

### Per-user-ify the singletons
- `ResumeProfile`: drop `id:"default"` → **`userId` PK** (one row per user). Keeps baseResumeKey/masterTex/whitelist/altResumeKey.
- `AppSettings`: `id:"default"` → **`userId` PK**. Its existing `profile` sub-object (targetRoles, seniorityLevel, currentBaseLPA, preferredIndustries, acceptableSeniority) **is** the per-user profile the free tier extracts from the resume. `getSettings()` → `getSettings(userId)`; cache becomes a per-`userId` LRU.
- **Extract `id-cache` (company-size / location / company ids) to its own GLOBAL table.** It's public LinkedIn reference data — must stay shared, and today it risks living inside the settings singleton (FINAL minor gap). Do this *before* settings goes per-user or you shard a shared cache.

### Split `Job` → shared corpus + per-user match
```
Job (shared)      // the public posting — deduped, discovered once, salary extracted once
  id, source, company, role, jdText, applyUrl, location, jobProviderId,
  salary* (shared extraction), postedAt, discoveredAt, dedupeKey
  // REMOVE all per-user fields ↓

JobMatch (per-user join)          @@id([userId, jobId])
  userId, jobId,
  matchScore Int?, aiScore Int?, aiReason?,     // per-user relevance (their profile)
  appStage, skipSource?, pinned, closedAt?,     // pipeline state — was on Job
  tailoredPitch?, tailoredResumeKey?, altTailoredResumeKey?, tailorLog?,  // Paid
  outreachState, directAppliedAt?, referredAt?, needsTailoring, ...
  createdAt, updatedAt
  @@index([userId, appStage])
```
**Why:** the JD/salary is identical for everyone (extract once, cheap at 5 users but correct at scale); relevance and pipeline state are per-user. This is FINAL's R3. At 5 users the win is small; the point is you never rewrite it later.

### Outreach (Phase 3 — scoped + pool)
- `Contact`, `Outreach`, `ChannelThread`, `ThreadMessage`, `WebhookEvent` all gain **`userId`**, and thread lookups gain **`accountId`** (FINAL C3 — non-negotiable when accounts are shared).
- New pool + rotation tables — see §6.

---

## 3. The filtering / matching system (what you asked about)

You described: *"one system that fetches all the jobs, then filters per user, then sends each user their own mail."* That's already the friend-digest shape — here it is generalized:

```
                    ┌─────────────── ONCE PER DAY, GLOBAL (READ) ───────────────┐
  discoverJobs()  → dedupe → shared Job corpus → salary extract (once/job)
                    │  query set = UNION of active users' {keywords, location},   │
                    │  deduped + capped (protects source-API quotas)              │
                    └─────────────────────────┬─────────────────────────────────┘
                                               │
        ┌──────────────────── PER ACTIVE USER (MATCH) ────────────────────┐
        │  filter corpus by THEIR profile+settings:                        │
        │    salary floor (settings.search.minSalary / profile.*)          │
        │    role/keyword match (profile.targetRoles)                      │
        │    location, seniority, freshness                                │
        │  → Free:  cheap TRIAGE model → matchScore → upsert JobMatch      │
        │  → Paid:  flagship scoreJob(profile) → aiScore+reason → JobMatch │
        └──────────────────────────────┬──────────────────────────────────┘
                                        │
        ┌──────────────── PER USER (DELIVERY) ─────────────────┐
        │  assemble digest from their new JobMatch rows since   │
        │  last send → personalized email (generalizes          │
        │  sendFriendDigest: recipient = User, floor+keywords    │
        │  come from their profile, not a static config list)   │
        └───────────────────────────────────────────────────────┘
```

**Key design calls:**
- **Discovery stays a single global sweep**, not per-user — the corpus is shared. The *query set* is the union of users' interests (deduped) so niche interests are covered without N× source calls. At 5 users this is one modest run.
- **Free = triage-only relevance** (the cheap model already exists: `settings.ai.triageModel`). Flagship scoring is a Paid-only pass over the same corpus. This is the free-tier abuse guard (FINAL S4) built in from day one.
- **`sendFriendDigest(jobs, recipient)` is the seam.** Today `recipient` is a `{email, minBaseLPA, keywords}` from config; make it a `User` whose `minBaseLPA`/`keywords` are derived from their profile. The email template barely changes.
- **Decouple auto-outreach from discovery.** Today `discover` auto-approves + `enqueueOutreach` inline (owner only). In multi-tenant, discovery produces **corpus + matches only**; outreach is a separate per-user opt-in plane (Phase 3). This is the single most important structural change to make early, even before outreach exists — so discovery stays a pure READ/MATCH job.

---

## 4. The multi-step build plan

Five phases. Each is independently shippable. The existing owner becomes **user #1** on the new schema (non-breaking).

### Phase 0 — Tenancy foundation *(no user-visible change)*
**Goal:** the app runs exactly as today, but every row is owned by user #1 and every access path carries `userId`.
- Add `User` + Auth.js adapter tables. Kill HTTP-Basic shared-password (`middleware.ts`); Auth.js v5 magic-link email (matches FINAL R5).
- Introduce a **data-access layer** (`db.forUser(userId)`) — the *primary* isolation. Thread `userId` through `getSettings()`, the LLM adapter (`chatCompletion` gains a user/context param — FINAL S2), `message-writer`, `people-finder`, `limits`, `safety`.
- **Migration (expand→backfill→contract), production-safe (FINAL C6/R13):**
  1. Dedupe existing `ThreadMessage` rows, then `CREATE UNIQUE INDEX CONCURRENTLY` (Prisma won't do CONCURRENTLY — raw SQL on `DIRECT_URL`).
  2. Add `userId` nullable everywhere; backfill to owner; `ADD CONSTRAINT NOT VALID` + `VALIDATE` (avoid the full-scan lock) before NOT NULL.
  3. Dual-write `id:"default"` **and** `userId` during the settings/resume transition — don't hard-flip.
  4. Extract `id-cache` to its own global table first.
  5. Split `Job` → `Job` + `JobMatch`; backfill owner's pipeline state into `JobMatch`.
- **RLS: not now.** Data-access layer is the isolation at 5 users; RLS is a Phase-4 backstop (FINAL R2/S1 — it fights the transaction pooler and the cross-tenant worker).
- **Exit:** owner uses the app unchanged; all queries go through `db.forUser`; zero `id:"default"` reads remain.

### Phase 1 — Free tier (the digest product)
**Goal:** a stranger signs up, uploads a resume, and starts getting personalized job emails.
- **Signup + magic-link login.**
- **Resume → profile extraction** (net-new; nothing does this today): parse uploaded PDF → LLM extracts `{targetRoles, seniorityLevel, currentBaseLPA, skills, preferredIndustries}` → writes the user's `AppSettings.profile`. User can edit in settings.
- **Per-user settings** page/API scoped by `userId` (salary floor, roles, locations, digest frequency).
- **Matching pipeline** (§3): discovery union-query → per-user filter → triage-score → `JobMatch`.
- **Per-user digest cron**: generalize `sendFriendDigest` to iterate active free users. Double-opt-in + unsubscribe (compliance).
- **Exit:** N test users each get a correctly-filtered daily email; zero cross-user leakage; discovery is one global run.

### Phase 2 — Paid Intelligence (dashboard + scoring + tailoring)
**Goal:** paying users get the full app minus outreach.
- **Billing + entitlements**: Stripe; `User.tier` gates flagship scoring, dashboard, tailoring. Free-tier abuse guard = verified email + triage-only (already true from Phase 1).
- **Per-user dashboard / board** — the current UI, scoped by `userId` via `JobMatch`. **IDOR:** every job/resume id from body *or* query is ownership-checked in the data layer; presigned S3 URLs minted only after (FINAL S5 — resume download is the sharp edge).
- **Flagship scoring pass**: Paid users get `scoreJob(profile)` over their matches (reasons, salary intel).
- **Per-user resume tailoring**: the LaTeX pipeline scoped per user; tailored artifacts land on `JobMatch`, not `Job`.
- **LLM metering**: `userId` on `LlmUsage`, per-user pre-call budget + degradation ladder (FINAL R9). Aggregate kill-switch deferred to Phase 4.
- **Exit:** a paid user sees their board, flagship scores, salary, and can tailor; a free user cannot; billing state gates it.

### Phase 3 — Outreach (SEND), serial rotation — *gated by §8*
**Goal:** opt-in paid users get automated referral outreach through the rotating single seat.
- **Webhook tenant-routing FIRST** (FINAL C3/R10): every thread lookup scoped by `accountId AND provider/chat id`; `providerChatId` unique per `(accountId, chatId)`; reply alerts route to `thread.userId`. Ship this *with* the pool, never after.
- **Serial-rotation subsystem** (§6) — the big new piece.
- **Concierge persona + relay inbox** (FINAL C5/R11): platform-owned third-person templates (non-editable so a user can't re-introduce impersonation); retrained reply classifier for third-person recruiter language; relay inbox so conversations don't dead-end at the first reply.
- **TTL contact suppression** written transactionally at send (FINAL C4/R4) — even with one active account, two users can target the same recruiter.
- **Rolling-window rate limits** per account (FINAL R8/S3) — keep the existing rolling 24h/7d design, never calendar-day buckets.
- **Exit:** a small watched cohort of opt-in users get invites/DMs sent via rotated accounts; replies relay to the right user; no cross-tenant leak.

### Phase 4 — Scale hardening — *when >~50 users or >1 seat*
Deferred deliberately (§7): RLS as backstop; aggregate LLM circuit breaker + shadowban/acceptance-rate monitor (FINAL S6); pool-fairness/target-availability tracking; org/team tier; durable per-account queue (Inngest/QStash) if serial rotation becomes the bottleneck; BYO-LinkedIn as an alternate SEND path (FINAL V2).

---

## 5. Dependency graph

```
Phase 0 (tenancy) ──┬─→ Phase 1 (Free digest) ──→ Phase 2 (Paid Intelligence) ──→ Phase 3 (Outreach)
                    │                                                                    ↑
                    └────────────────────────────── §8 legal/ToS gate ──────────────────┘
```
Phases 1 and 2 can overlap once Phase 0 lands (you chose to build both Intelligence tiers together). Phase 3 is hard-gated on §8 **and** on the rotation PoC (§6).

---

## 6. The account-rotation subsystem (serial, 1 seat)

This is the novel, riskiest component. Design it as a self-contained service with a clear state machine — do a **PoC before committing** (measure LinkedIn lock/challenge rate under real send load).

### Model
```
LinkedInAccount {
  id, personaName, linkedinLogin,          // the pool identities you rotate
  unipileAccountId?,                         // set only while it OCCUPIES the seat
  sessionRef,                                // Playwright storage-state (cookies) blob/secret ref
  status  WARMING|ACTIVE|COOLDOWN|LOCKED|QUARANTINED,
  dailyInvitesUsed, weeklyInvitesUsed,       // rolling windows (not calendar)
  lastActiveAt, lockedReason?, warmupStartedAt
}
SeatState (singleton) { activeAccountId?, occupiedSince?, nextRotationAt }
AccountRateLedger (per account, rolling 24h/7d)     // FINAL R8
AccountContactLog { accountId, linkedinProviderId, contactedAt }  // TTL, tx-at-send (FINAL C4)
```

### The rotation loop (one account occupies the seat at a time)
```
1. SCHEDULER picks next eligible account (status ACTIVE|WARMING, under rolling caps,
   longest-rested first).
2. SWAP-IN (Playwright session manager):
   a. Disconnect current account from UniPile (frees the seat).
   b. Load target account's saved storage-state → open LinkedIn → verify session live.
   c. If checkpoint/challenge/lock → run unlock flow (see below); on failure → mark
      LOCKED/QUARANTINED, pick another account, alert ops.
   d. Connect that account to UniPile (occupies the seat) → confirm webhook/DM access.
3. DRAIN: run that account's queued invites/DMs for its users, respecting per-account
   rolling caps + send window, until batch done or cap hit.
4. SWAP-OUT: persist fresh storage-state; update ledger; set nextRotationAt.
5. Repeat.
```

### Playwright session manager (the hard part)
- **Persist `storageState`** (cookies + localStorage) per account; reuse to avoid re-login (re-login is the strongest ban signal).
- **Challenge handling**: detect LinkedIn checkpoint/OTP/"unusual activity" pages. OTP → route to the phone/email owning that account (manual or automated inbox read). This is the operational tax — budget for it.
- **Unlock flow**: appeal/verify page automation where possible; otherwise quarantine + human.
- **Fingerprint hygiene**: stable per-account proxy/IP + user-agent; never share an IP across personas (correlated bans).

### Consequences of serial (state these plainly)
- **Throughput = 1 account's daily cap ÷ rotation overhead.** With ~8–10 invites/account/day and swap cost, total daily sends across *all* users is small. This caps how many outreach users you can serve — surface it as a **waitlist/quota**, don't oversell.
- **Swap latency** means outreach is bursty, not real-time. Fine for referral cadence; set user expectations.
- **A lock takes down that account's batch**, not everyone's (only one is active) — serial actually *contains* blast radius vs. a concurrent pool.
- **Legal exposure is unchanged** — automating logins + scraping + sending on pool personas is the §8 gate regardless of rotation mechanics.

---

## 7. What we deliberately do NOT build at 5 users

Stating these so they're not mistaken for oversights:
- **RLS** — data-access layer suffices; RLS fights the pooler + cross-tenant worker (FINAL S1). Add in Phase 4.
- **Pool-fairness / target-availability math** (FINAL C4/§6) — irrelevant with one active account and 5 users.
- **Aggregate LLM circuit breaker & shadowban monitor** (FINAL S6) — per-user caps + manual watch are enough at this size.
- **Org/team tier, durable queue infra** — Phase 4.
- **Quadratic-cost defenses (C2)** — the shared-corpus shape already prevents it; no extra work needed at 5 users.

---

## 8. Remaining gates & open decisions

1. **LinkedIn ToS / GDPR sign-off (FINAL D3)** — go/no-go for Phase 3. Automated login + scrape + send on pooled personas, storing third-party recruiter PII, is the real legal exposure. Decide before building the rotation subsystem, not after.
2. **Persona + relay is now *required*, not optional (FINAL D2)** — your serial-rotation choice means the sending identity is always a pool persona, never the user's own. So third-person concierge templates + a relay inbox are mandatory for Phase 3 (or descope to "one-shot pitch, user continues manually").
3. **Billing provider & price points** — Stripe assumed; set the Free/Paid price and the outreach quota (bounded by §6 throughput) before Phase 2 launch.
4. **Rotation PoC** — measure lock/challenge rate on 2–3 accounts under realistic send load *before* Phase 3 commits. Highest-risk assumption in the whole plan.

**Bottom line:** Phases 0–2 (tenancy → Free digest → Paid Intelligence) are low-risk, monetizable, and scale cleanly — build them now. Phase 3 (serial-rotation outreach) is the hard, legally-gated, throughput-limited add-on — PoC it, gate it, waitlist it.
