# RED-TEAM Review: Multi-Tenant SaaS Architecture Plan

**Reviewer role:** Independent Staff Engineer, adversarial review · **Date:** 2026-07-08
**Under review:** `docs/multi-user-architecture.md` · **Verified against:** live code at `/Users/anandmohanjha/Desktop/projects/job-seeker`

---

## Verdict

**Sound-with-major-gaps.** The plan's spine is correct and unusually honest for a migration doc: two-plane split, row-level `userId`, a per-account (not per-user) ledger and fan-out, the concierge-persona integrity admission, and the capacity gate are all the right calls, and its reading of the *current* code is accurate on nearly every point I checked. But it has **one architectural blind spot that invalidates its own throughput math** — it treats the shared LinkedIn accounts as pure *senders* and never accounts for the fact that **discovery and referral-target-finding pour ~20-100+ LinkedIn *search/scrape* API calls per user per run onto the very same pool accounts** (verified in code), and LinkedIn bans for search/scrape volume, not just invites. On top of that it under-specifies the three things most likely to blow up in production: **multi-tenant webhook routing** (no `account_id` disambiguation → cross-tenant reply/PII leak), the **concierge relay inbox** (hand-waved in one clause but is a whole product surface), and **migration DDL safety** (locking index builds, a unique index that will *fail to create* on existing duplicate rows). It is safe to build *from*, not safe to build *to* as written.

---

## Critical gaps

### C1. The throughput ceiling ignores that discovery + people-finding run on the SAME pool accounts — LinkedIn bans for search volume, not just invites. (§1, §5, §7)

**What's wrong.** §1's ceiling math is `healthy_accounts × per_account_safe_invites`. It counts *only connection invites*. But the live code runs a large volume of **LinkedIn search / profile-scrape** calls through the *same* account credential, and the plan's §7 makes discovery **per-user**, multiplying that load by N:

- Discovery LinkedIn source: up to **6 search + ~48 `getJobDetail` (a paid call) + ~48 `getCompanyProfile`** per run (`src/sources/linkedin.ts:55,96`; `unipile/client.ts:208,212`; company-size filter in `discover/route.ts`).
- Referral target-finding runs **inside** discovery for every auto-approved job: `enqueueOutreach → findTargets` fires **3 `searchPeople` × up to 6 pages each = up to 18 search calls + `getJobDetail` + up to 3 `fetchProfile` ≈ 20-23 LinkedIn calls *per approved job*** (`src/outreach/people-finder.ts:262-266`, `searchPeople` pagination `unipile/client.ts:177-188`). Ten approved jobs ≈ **200+ scrape calls in one run.**
- Every one of these uses `config.owner.linkedinAccountId` today (`people-finder.ts:313`, `discover/route.ts`), i.e. in the pool model it would use the user's **assigned sending account**.

**Why it matters.** LinkedIn's enforcement that actually restricts accounts at volume is the **Commercial Use Limit / search-and-scrape detection**, which is independent of the invite cap. An account doing 8.5 invites/day *and* 100-200 profile/company/people searches/day looks far more like automation than a human job-seeker and is *more* likely to be restricted — and when it is, it takes down **outreach for every user assigned to it** (sticky assignment, §5.2), plus their in-flight referrals stall (§5.4). The binding constraint on the pool is plausibly **search volume, not invites**, and the plan's ceiling is computed against the wrong resource.

**Failure scenario.** Month 3: 40 active users, per-user daily discovery. Each user's assigned account runs their discovery (dozens of `getJobDetail`/`searchPeople` calls) *plus* everyone-else-on-that-account's discovery. Accounts start getting `account_restricted` from search volume while nowhere near the invite cap. Correlated restrictions cascade; the "25 healthy accounts" assumption collapses to 10; the waitlist you sized for 40 users can now safely serve 15.

**Direction.**
1. **Separate read accounts from write accounts.** Do job discovery and people-search from a distinct pool (or from cached/shared results, see C2), and reserve sender accounts for invites/DMs only. Never let per-user discovery scrape from a sender account.
2. **Re-derive the ceiling against search-call budget per account**, not just invites, and state both limits.
3. Discount for warmup: §1.2 subtracts *dead* accounts (85% healthy) but not *healthy-but-warming* accounts running at 5/day; with continuous ban-and-replace churn a standing fraction is always in warmup, so effective throughput is below the stated 213/day.
4. Haircut the per-account safe invite rate for *shared/persona* accounts — a concierge account blasting unrelated pitches across many industries is a stronger ban signal than one coherent job-seeker; personal-account tolerances (8.5-20/day) are optimistic for pooled ones.

**Net: the honest ceiling is lower than ~40-100, and gated by scrape volume the plan doesn't model.**

---

### C2. Per-user discovery of shared public jobs is architecturally wrong at 1000s — quota blowout, N× LLM re-scoring, N× paid Unipile detail calls, storage bloat. (§3.1, §7, §8)

**What's wrong.** The plan makes `Job` per-user (`+userId`, §3.1) and discovery per-user (§7). But the *inputs* are shared public feeds hit through **globally-quota'd / metered** APIs, and the id-cache/settings are a single `id:"default"` row (`src/lib/id-cache.ts:22`):

- **Adzuna, JSearch (RapidAPI), Remotive, RemoteOK** are metered per key with global daily/monthly ceilings. 1000 users each running daily discovery (Adzuna up to 18 calls/run, JSearch 6/run, etc.) blows the free/basic tiers in a single wave — these are *platform-wide* quotas, not per-user.
- **`getJobDetail` is a paid Unipile call** (`src/sources/linkedin.ts:91`). The same public LinkedIn job discovered by 500 users targeting "backend engineer India" is detail-fetched **500×** for identical bytes.
- **Flagship scoring is 1 `gpt-4.1` call per surviving job** (`src/scoring/ai-scorer.ts`, `ai-adapter.ts`). The *same* job is re-scored once per user → the LLM bill is `O(users × overlapping_jobs)`, the dominant cost line.
- `Job.jdText` is `@db.Text`; per-user duplication of heavily-overlapping corpora is millions of near-identical fat rows.

**Why it matters.** This is the difference between Plane A "scales ~linearly, meterable" (the plan's core promise, §0) and Plane A being quadratic in cost. The plan's own §16.5 says "pooled LLM cost is load-bearing for unit economics" — but the *architecture* it chose maximizes that cost.

**Direction.** Split discovery into **shared corpus fetch** (one global run per source/query-cluster, dedup'd, cached — jobs are public and identical across tenants) + **per-user matching**. Model `Job` as a **shared row** with a per-user `JobMatch/JobStatus` join (`@@id([userId, jobId])`) carrying score, appStage, skip, outreachState. Reserve flagship LLM for the top-K per user (cheap embedding/triage filter first — the `triageModel` already exists). This also naturally fixes the source-quota problem (one fetch, not N) and the storage bloat. The genuinely per-user cost then collapses to *matching the top slice*, which is what the §8 meter should bound. (The `isConnection` flag on referral targets *is* per-account and must stay per-account — but the base job/company/hiring-team data is shared.)

---

### C3. Multi-tenant webhook routing is unsolved: acceptances/replies are not disambiguated by `account_id` → wrong-tenant routing and cross-tenant PII leak. (§3.1, §5, and `app/api/webhooks/unipile/route.ts`)

**What's wrong.** The plan says (§3.1) "resolve target thread → its `userId` on handling" but never specifies **how**, and the live handlers resolve threads in a way that is *unsafe* the moment an account is shared:

- `handleInviteAccepted` matches the thread by **`candidateProviderId` only** (`route.ts:167-174`), ignoring `data.account_id`. The dedupe id is `${account_id}:${user_provider_id}` (`route.ts:59`) — so the payload *has* the account — but the thread lookup drops it. With shared accounts, recruiter P can be invited by account A (user 1) *and* account B (user 2). When A's invite is accepted, `findFirst` by `candidateProviderId=P` may flip **user 2's** thread (on B) to CONNECTED. User 2 then DMs from B a recruiter who never accepted B's invite → "not connected" burn; user 1's real acceptance is missed.
- `handleMessageReceived` primary path matches by `providerChatId` with `findMany` + loops calling `handleInboundReply` on **every** match (`route.ts:216-221`); the out-of-order fallback matches by sender `candidateProviderId` with `findFirst` (`route.ts:234`) — again no account scoping.
- The reply-alert (`handleInboundReply` → `sendReplyAlert`, `outreach-tick.ts:538`) currently emails `config.owner`. In multi-tenant it must email the thread's **owner user**. If chat-id resolution matches the wrong tenant's thread, **user A receives the recruiter reply — including the recruiter's name/message/PII — for user B's outreach.** That is a reportable cross-tenant data leak.

The plan's `AccountContactLog` (§3.3) is what *would* keep chat-id → single (account,recipient) → single user. But the plan never connects the two: **AccountContactLog is load-bearing for webhook correctness, not just spam-avoidance**, and if it is ever raced or bypassed (see C4), replies leak across tenants.

**Direction.** Every webhook thread lookup must be scoped by **`accountId = data.account_id` AND** the provider id/chat id. Make the (account, candidateProviderId) pair the resolution key for acceptances and the out-of-order reply fallback; make `providerChatId` unique per account. Route the reply alert to `thread.userId`. State explicitly that the webhook secret is *global* (one Unipile workspace = one secret) and that tenancy is resolved by `account_id` inside, not by per-user secrets.

---

### C4. `AccountContactLog` starves later users and its check-then-send is racy; sticky 1-account assignment makes target availability (not just budget) the fairness problem. (§3.3, §5.2, §5.5, §6)

**What's wrong.**
- The schema is `@@id([accountId, linkedinProviderId])` with a single `contactedAt` (§3.3). As a primary key this is a **permanent** lock: once account A touches recruiter X (for any user), X is off-limits for A. Popular recruiters at desirable companies are exactly the high-value targets *many* users want; whoever's discovery hits first **permanently locks every other user on that account out of that recruiter.** For a small company with 2-3 reachable recruiters, the first one or two users exhaust the pool and later users on that account get **zero reachable targets there.**
- Because assignment is **sticky, one account per user** (§5.2) and suppression is **per-account**, a user can *only ever* reach people their account hasn't already burned. A heavily-loaded account gives its users poor target availability even though *other* accounts could reach those people. The plan's fairness math (§6) equalizes *invite budget* but not *target availability* — the scarcer resource.
- The gate is **check-then-act** across two phases: people-finder pre-filters at **enqueue/discovery** time (§5.5), but the actual send + log write happens later at **send** time. Between them, another user's thread on the same account can send to the same person. The plan never says the log insert is atomic with the send (unique-constraint insert inside the send tx, catch conflict → skip). Per-account queue concurrency=1 (§7) helps *within* one account's tick but not across the enqueue→send gap or across the discovery path.

**Failure scenario.** Two users on account LI-7 both auto-approve a job at a 200-person startup with one recruiter. Both discovery runs pre-filter "recruiter not yet in AccountContactLog," both enqueue a thread, both fire in the same window → the recruiter gets **two invites from the same LinkedIn person** (the exact spam→restriction pattern §3.3 exists to prevent).

**Direction.** Add a cooldown/TTL to suppression (not a permanent PK); write the suppression row **transactionally at send time** with a unique constraint as the arbiter (loser skips and re-picks). Consider relaxing strict 1-account stickiness for *cold-target sourcing* (keep it for an *in-flight thread's* invite→DM continuity, which is the real constraint) so a user isn't starved by their account's history. Track and alert on per-account *target-availability*, not just budget.

---

### C5. The concierge persona breaks reply routing, reply classification, resume/pitch framing, and requires a two-way relay inbox the plan reduces to one clause. (§5.1, and message/reply code)

**What's wrong.** §5.1 correctly identifies the impersonation problem and picks the concierge framing, but it under-builds the consequences, all of which are live code today written for **first-person peer outreach**:

- **Templates are first-person and user-editable.** `firstDm` is *"I'm currently working as a Software Engineer at Salescode.ai…"* (`config.ts:156-169`), sent from a *different real person's* account. Concierge requires rewriting to third person — and because `settings.templates` is per-user editable (`settings.ts`, `message-writer.ts:68`), a user can simply **edit it back to first-person impersonation**, re-introducing the fraud the persona was meant to remove. Under a shared persona, templates cannot be freely user-editable; the plan doesn't address this conflict.
- **The AI pitch is first-person.** `Job.tailoredPitch` is generated in the candidate's voice; it must be regenerated third-person or it clashes with the persona wrapper.
- **Reply classification is tuned for peer language.** `classify-reply.ts` keys on "send me **your** resume", "happy to refer **you**" (`classify-reply.ts:37-54`). A recruiter replying to a *concierge* says "have **them** apply here" / "happy to refer **your candidate**" — the POSITIVE/NEGATIVE lists miss it, degrading auto-stop and reply detection.
- **The relay inbox does not exist.** Replies land in the **pool account's** inbox. §5.1 says "the persona forwards/relays" — but there is no mechanism: the candidate can't reply as themselves (it's not their account), so *every* back-and-forth after the first reply must be proxied through the platform (a shared-inbox / relay product surface, notification + compose UI, threading, attachment relay). Today the flow just fires one email alert to the owner (`outreach-tick.ts:538`) and stops. **Without the relay, the concierge model dead-ends at the first reply** — which is the whole point of a referral tool.

**Direction.** Lock the persona-side templates (platform-owned, third-person, non-editable); let users edit only the candidate-facing pitch content within guardrails. Retrain/extend reply classification for third-person recruiter replies. **Scope the relay inbox as a first-class feature** (or descope concierge to "one-shot pitch + email the candidate the recruiter's LinkedIn link to continue manually" and be honest that the platform can't carry the conversation). Route reply alerts to `thread.userId`, not the owner.

---

### C6. Migration DDL is not production-safe: a unique index that will FAIL to create, locking index builds, locking NOT NULL, and RLS-before-code-migration. (§14, §3.1)

**What's wrong.** §14 claims "each phase independently deployable and reversible; the app stays live," but several steps take heavy locks or fail outright on a live DB:

- **The new `@@unique([threadId, providerMessageId])` (Phase 1) will error on creation** if any duplicate `(threadId, providerMessageId)` rows already exist — and audit **E3** says duplicate DMs *already happen* and the current guard is inert (no unique index, so P2002 never fires; confirmed `schema.prisma:280` is a plain `@@index`, `thread-worker.ts:124` catch is dead). There are almost certainly existing duplicate rows. The migration must **dedupe existing rows first**; the plan doesn't mention it.
- **Prisma does not create indexes `CONCURRENTLY`.** `CREATE UNIQUE INDEX` on `Contact` (the unique swap, §3.3) and on `ThreadMessage`, plus the new composite indexes on `Job`/`ThreadMessage`/`Outreach` (§3.1), take `ACCESS EXCLUSIVE` / full-scan locks that **block writes** on those tables — stalling live outreach/discovery during the migration.
- **`SET NOT NULL` on `userId` (Phase 2 contract)** on `Job`/`ThreadMessage` (potentially large) does a full-table validation scan under `ACCESS EXCLUSIVE` in the Prisma path.
- **Old unscoped writes keep running during expand.** During Phases 0-2 the old code still does `prisma.job.create` / `contact.upsert({where:{linkedinProviderId}})` with **no `userId`** (`enqueue.ts:97`, discovery). Rows created between backfill and contract have NULL `userId` → the `SET NOT NULL` fails unless re-backfilled immediately before, in the same lock window.
- **RLS enabled in Phase 2 while raw-`prisma` code still runs.** The plan enables RLS "on high-value tables" in Phase 2 *and* migrates routes in Phase 2. Any code path not yet on the `SET LOCAL` tenant wrapper will see **zero rows or errors** the moment RLS is on. RLS must be **last**, after 100% of read/write paths are proven on the wrapper — never interleaved.
- **The singleton flip is not cleanly reversible.** Moving `AppSettings`/`ResumeProfile` from `id:"default"` to `userId` (§3.2) breaks all old code reading `where:{id:"default"}` (which is *everywhere*: `settings.ts:180`, `id-cache.ts:22`, `thread-worker.ts:503`). Rollback after this flip is not a no-op; §14's "reversible" is overstated for this step.

**Direction.** Use raw SQL migrations with `CREATE INDEX CONCURRENTLY` (outside a tx, on `DIRECT_URL`), add `NOT NULL` via `ADD CONSTRAINT ... NOT VALID` + `VALIDATE CONSTRAINT` (PG12+) to avoid the full-scan lock, dedupe `ThreadMessage` before the unique index, keep RLS as the final phase, and dual-write `id:"default"`+`userId` during the settings transition rather than a hard flip.

---

## Significant gaps

### S1. RLS via `SET LOCAL` in a transaction fights the transaction pooler and the per-account worker. (§2.3, §4.3, §7)

The `SET LOCAL app.current_user_id` approach is correct *in principle* for a transaction pooler, but the plan calls the cost "slight overhead." Two real problems: (a) wrapping *every* query in an interactive Prisma transaction holds a pooled connection for the tx duration and adds BEGIN/SET/COMMIT round-trips — the opposite of what transaction-pooling (short statements) is for, and a real connection-budget/latency concern at 1000s of users; (b) **the per-account outreach worker reads across ALL users' threads** (fan-out is per-account, §7) — it must render each thread's owner's messages, attach the owner's resume, email the owner. So the exact tables the plan wants RLS on (`ChannelThread`, `Job`, `ThreadMessage`) are the ones the worker must read **cross-tenant**, requiring a large `BYPASSRLS` surface that undermines "RLS as backstop." Reconcile this explicitly: which principals bypass, and accept that RLS protects the *web request* path, not the worker path.

### S2. Threading `userId` through `getSettings()` and LLM metering is a large, error-prone refactor the plan understates. (§3.2, §8)

`getSettings()` is called with **no user context** from deep, ubiquitous call sites — `ai-adapter.loadProvider` (`ai-adapter.ts:63`), `message-writer.renderMessages` (`message-writer.ts:67`), `limits.ts`, `people-finder`, `id-cache`, `safety.ts`, etc. Every one must acquire and pass `userId`. Similarly §8 says the LLM adapter "stamps `userId` from the call context," but **there is no call context today** — `chatCompletion` takes no user param (`ai-adapter.ts:72`). You need AsyncLocalStorage or an explicit param on every LLM call site (scoring, triage, tailoring, post-extraction). A single missed site = **unmetered/uncapped LLM spend attributed to nobody** — a silent cost leak that defeats §8's entire purpose. Also: the plan says the settings cache is "60s"; it's actually **10s** (`settings.ts:173`) — minor, but the per-`userId` LRU point stands and is correctly identified.

### S3. UTC-day-bucket ledger reintroduces the boundary-burst ban risk the current rolling-window design deliberately avoids. (§6)

§6 offers "sum today+partial-yesterday, **or** simplified to UTC-day buckets." These are **not** equivalent for ban safety. The current code uses **rolling 24h/7d windows precisely so it never exceeds N invites in *any* 24h span** (`limits.ts:4-6,52-61`; audit confirms "no calendar/timezone off-by-one"). A UTC-day bucket lets an account send its full cap at 23:59 UTC and again at 00:01 UTC — **2× the cap in two minutes**. Compounded by per-user timezones (§6 wants per-user send windows): a PST user's 9am-9pm window straddles the 00:00-UTC reset (≈4pm PST), so the account's "daily" budget refills mid-session. **Keep rolling windows** in `AccountRateLedger` (or bucket + a rolling-sum guard); do not "simplify" to calendar-day.

### S4. Cost model has no numbers; several tiers plausibly lose money and the Free tier is an LLM-farming vector. (§11)

§11 is a shape, not a model. Concrete pressures the plan must actually compute: **Unipile is a per-account fixed cost** (~29 accounts regardless of active users) — at ~40 active outreach users that's a large per-active-user fixed cost *before* LLM/infra/Stripe fees. **Flagship `gpt-4.1` scoring per user per job** (C2) is the dominant variable cost; a heavy discovery user can exceed a $20-30 Starter price in LLM alone. The **Free tier** ("20 scored jobs/day × 7 days") burns real flagship tokens per signup with **no payment and no identity friction** → farm free accounts to mine LLM. The plan needs a $/user/tier P&L with the C2 fix assumed, a global (platform-wide, not just per-user) LLM spend circuit-breaker, and free-tier abuse controls (verified email + triage-only scoring for Free).

### S5. IDOR surface is broader than "`:id` routes" — most mutations pass the id in the body/query, and resume download authz is the sharp edge. (§4.4)

§4.4 says "any `:id` route verifies `row.userId === session.userId`." But there is only **one** path-param route (`app/api/jobs/[jobId]`); the real IDOR surface is the **body/query-param** mutations: `jobs/action`, `jobs/close`, `jobs/pin`, `jobs/referred`, `jobs/applied`, `jobs/tailor`, `outreach/send`, `outreach/confirm`, `companies/blacklist`, and especially **`resume/download`** / `resume/tailored` (S3 key or jobId in query). The ownership check must be enforced in the tenant data layer on **every** id that enters a query from the request (body and query included), and presigned URLs minted only after that check. Framed as "`:id` routes" it will be under-implemented. Also note current auth is HTTP **Basic** with a shared password compared `===` (`middleware.ts`) — the plan correctly kills it (§4), but the migration must not leave the Basic path enabled alongside Auth.js.

### S6. Observability misses the two failure modes that actually sink this business: shadowbans and aggregate cost runaway. (§13, §5.4)

The distress detector only trips on **explicit** `429`/`account_restricted` from a *send* (`safety.ts:38`, `client.ts:28-41`). A **shadowban** (LinkedIn silently stops delivering invites; acceptance rate → 0, no error code) is **invisible** to it. §5.4 hand-waves "elevated invite-rejection rate" as a signal but defines no detector. Define a concrete **acceptance-rate-drop / delivery-anomaly** monitor per account and per cohort — that's how a mass-ban shows up before the API ever returns an error. Separately, §8's caps are **per-user**; there is no **platform-aggregate** LLM kill switch, so a systemic bug hits every user's cap simultaneously with no global backstop. Both are load-bearing for "don't let a mass-ban or cost-runaway go unnoticed."

### S7. Discovery/people-finding coupling means the plan's per-account outreach fan-out (§7) doesn't cover where target-finding actually happens. (§7, and `enqueue.ts`/`people-finder.ts`)

Today `findTargets` (the ~20-call scrape) runs **inside `enqueueOutreach` inside discovery** (`discover/route.ts` → `enqueue.ts:58`), not inside the outreach tick. The plan's §7 topology fans out *sends* per account but leaves *people-finding* in per-user discovery — so the heaviest LinkedIn-scrape load isn't governed by the per-account concurrency/quota the plan designed. Decide explicitly which plane owns target-sourcing and which account it runs on, and budget its calls in the account ledger (ties back to C1).

---

## Minor gaps / corrections

- **id-cache / company-size should stay GLOBALLY shared, not per-user.** §9/§3 lean toward "add `userId` to everything," but `location:`/`company:`/`companySize:` ids are public LinkedIn reference data (`id-cache.ts`) — sharing them cross-tenant is *correct and beneficial* (dedup, fewer paid calls). Call out the exceptions to the blanket-`userId` rule so they aren't wrongly partitioned. (They currently live *inside* the `AppSettings id:"default"` row, so moving settings per-user would accidentally shard this cache — extract it to its own global table.)
- **Reconcile day-marker** is global (`reconcile:invite-accept:{date}`, `outreach-tick.ts:394`); §3.5 correctly says make it per-account (`…:{accountId}:{date}`) — good, just ensure it's actually done.
- **Plan says "60s process-wide cache"** for settings (§3.2); it's **10s** (`settings.ts:173`). Doesn't change the conclusion.
- **`sendForJobs` manual bypass** (§6): the plan says manual send must never bypass the account safety budget. Correct — but note the *current* code bypasses **both** daily *and* weekly caps for manual (`outreach-tick.ts:153-162`); in a shared pool the weekly cap is a genuine ban-safety limit, so manual must respect the per-account weekly ledger too, not just daily.
- **`WebhookEvent` global dedup id** collides across the shared workspace only if two accounts emit the same `message_id` — unlikely, but the acceptance dedup id is `account_id:user_provider_id` (good) while the message dedup id is bare `message_id` (`route.ts:59-64`); confirm Unipile message ids are workspace-unique.
- **Circuit-breaker `consecutiveFailures`** is per-thread (`thread-worker.ts:290`); with shared accounts consider a per-*account* failure spike as a distress signal too (§5.4 hints at it; make it explicit).

---

## Assumptions to validate (spike/PoC before betting)

1. **Per-account safe *search* volume** (not just invites) before LinkedIn restricts a pooled/persona account — this determines the real ceiling (C1). Run a small pool at realistic per-user discovery load and measure restriction rate. **Highest-priority spike.**
2. **Concierge-persona acceptance & reply rates** vs first-person, and whether persona accounts get restricted *faster* for the "unrelated pitches from one identity" pattern (C1, C5). The unit economics and the ceiling both depend on this.
3. **Transaction-pooler behavior under per-query `SET LOCAL` transactions** at target concurrency — connection-budget and p99 latency (S1). Prove it before committing to RLS-in-tx.
4. **Source-API quotas** at N× (Adzuna/JSearch/RapidAPI/Remotive) — confirm they are platform-wide and whether paid tiers scale to 1000s affordably; this decides shared-vs-per-user discovery (C2).
5. **Unipile per-account pricing and the acceptance→DM funnel** — validate that 5 invites/user/day yields *any* meaningful referral rate given persona acceptance rates (the plan's "meaningful progress = 10/day" may already be too low).
6. **LinkedIn ToS / legal sign-off on operating Plane B at all** — the plan itself flags this (§5.1, §16.2); treat it as a go/no-go gate, not a footnote, because a mass workspace ban is an extinction event for the pool.

---

## What the plan got RIGHT (keep this)

- **Two-plane split with a capacity gate on outreach** (§0-1) — the single most important framing; keep it verbatim.
- **Honest confrontation of the impersonation/ToS problem** (§5.1, §16.2) — most plans would paper over it; the concierge framing + "not-fraudulent ≠ ToS-compliant" + BYO target state is the right posture (just build the relay, C5).
- **Per-account (not per-user) fan-out and ledger** (§6-7) — correctly identifies the account as the unit of parallelism and constraint.
- **Row-level `userId` over schema/DB-per-tenant** (§2) with the pooler caveat surfaced (§2.3) — correct tenancy choice for this scale.
- **Accurate audit of the current code** — I verified the load-bearing claims (singleton `id:"default"` rows, no `userId` on domain tables, global rate counters in `limits.ts`, `claimDueThreads` partitioning globally by `jobId`, reconcile hardcoding `config.owner.linkedinAccountId`, inert idempotency guard with no unique index, `Contact.linkedinProviderId @unique`). All correct.
- **Two-dimensional dedup instinct** (§3.3) — the *need* is right even though the mechanism starves and races (C4).
- **Folding the audit's systemic fixes into the redesign** (§15) — correctly reclassifies E1/E3/E4/A1/A3 as multi-tenant *safety* issues, not cosmetics.
- **Graceful-degradation ladder for LLM budget** (§8) — the right shape once metering context exists (S2).

---

### The one that would have blown up in month 3

If I have to pick: **C3 (webhook cross-tenant reply routing).** It won't show in staging with one test user, it produces a *silent* wrong-tenant flip most of the time, and the day it routes a recruiter's reply-with-PII to the wrong paying customer, it's a breach notification — not a bug ticket. It's a two-line fix (scope every webhook thread lookup by `account_id`) that the plan, as written, does not require anyone to make.
