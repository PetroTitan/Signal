# Bluesky Follow Campaigns — architecture and risk assessment

Baseline: `origin/main` @ `a1f1522` (PR #180 merged). 4,544 tests green,
typecheck/lint clean.

---

## A. The existing system

**Relationship subsystem (PR #178 + #180).** DID-keyed candidates,
workspace-scoped repositories, an immutable confirmed-batch model
enforced by a database trigger, protected-account exclusion,
cursor-based import completeness enforced by a CHECK, exact-count
pagination, and a reconciliation model where an ambiguous mutation is
*never* auto-retried — it reads relationship truth and records
`reconciliation_required`. Manual Follow/Unfollow is bounded at
`MAX_RELATIONSHIP_BATCH_SIZE = 20` per request with `INTER_REQUEST_MS =
1000` spacing and a `MUTATION_RATE_LIMIT_FLOOR = 20`. **All of that is
preserved unchanged.**

**Durable job infrastructure already exists.** `vercel.json` runs four
crons; `/api/scheduler/tick` fires every 5 minutes, authenticated by
`authorizeCronRequest` (constant-time, accepts `CRON_SECRET` or
`SCHEDULER_TICK_TOKEN`, 503 when unconfigured, 401 on mismatch). It runs
`runtime = "nodejs"`, `maxDuration = 300`, and operates through the
service-role client.

**A durable claim primitive already exists.**
`core/publishing/execution-claim.ts` claims work with a guarded
compare-and-set UPDATE (`WHERE status='scheduled'` → `running`), records
claim metadata, and treats a stale `running` row as an operator-visible
anomaly. Its recovery is deliberately manual because a publish may have
succeeded.

**plpgsql + SECURITY DEFINER are established** in five migrations, so a
claiming RPC is in-convention. No `.rpc()` call site exists yet — this
will be the first.

**No AGENTS.md / CLAUDE.md / CONTRIBUTING exists** in the repository,
tracked or untracked. Conventions are taken from the code.

---

## B. Proposed durable architecture

### Infrastructure verdict: no external job system is required

Vercel Cron + Supabase Postgres are sufficient, and adding a paid queue
would be unjustified. The three properties a durable queue needs are all
available:

| Need | Provided by |
| --- | --- |
| Reliable repeated delivery | Vercel Cron (at-least-once, already in use) |
| Atomic multi-row claiming | Postgres `FOR UPDATE SKIP LOCKED` in a SECURITY DEFINER RPC |
| Crash-safe progress | Every outcome persisted per member before the next |

Vercel Cron is **at-least-once, not exactly-once**. That is handled
where it must be — in the database — by a unique index on
`(campaign_id, local_date)`, so a duplicate delivery finds the run
instead of creating one.

### Entities

1. **`bluesky_follow_campaigns`** — configuration and status
   (`draft | active | paused | completed | reauthorization_required |
   rate_limited | failed | cancelled`), requested quota, timezone,
   execution window, `next_run_at`, error fields.
2. **`bluesky_follow_campaign_members`** — the queue.
   `import_sequence BIGINT`, `unique (campaign_id, actor_did)`,
   lease columns (`claimed_at`, `claimed_by`, `lease_expires_at`),
   `attempt_count`, `next_attempt_at`, provider record identity.
3. **`bluesky_follow_campaign_runs`** — one frozen run per local
   calendar day. `unique (campaign_id, local_date)` is the cron
   idempotency key. Carries requested vs **effective** quota and the
   attempted / succeeded / skipped / failed counters.
4. **`bluesky_campaign_member_sources`** — attribution, many-to-many, so
   one DID from five targets is one member with five source rows.
5. **`bluesky_identity_daily_usage`** — per-(identity, local date)
   consumption, so two campaigns sharing an acting identity cannot
   jointly exceed its allowance.
6. **`bluesky_campaign_kill_switches`** — global and per-identity.

`bluesky_relationship_actions` gains three **nullable** columns
(`campaign_id`, `campaign_run_id`, `campaign_member_id`) so campaign
follows land in the existing audit trail with its existing invariants
intact. No concept is duplicated.

### Claiming

A single SECURITY DEFINER RPC does the atomic work:

```sql
update bluesky_follow_campaign_members m
   set status='claimed', claimed_by=?, lease_expires_at=now()+interval
 where m.id in (
   select id from bluesky_follow_campaign_members
    where campaign_id=? and status in ('queued','retryable')
      and (next_attempt_at is null or next_attempt_at <= now())
    order by import_sequence
    for update skip locked
    limit ?)
returning *;
```

`FOR UPDATE SKIP LOCKED` is what makes two concurrent workers unable to
claim the same row — not application logic. Ordering is by
`import_sequence` with `id` as the unique tiebreaker; **there is no
OFFSET anywhere**, so claiming cost does not grow with queue position.

Expired leases are reclaimable by the same RPC (`status='claimed' AND
lease_expires_at < now()`). That is safe here — unlike the publishing
path — because a follow's ambiguity is resolvable: the worker reads
relationship truth before re-attempting, which is the reconciliation
model already built and tested.

### Day, window and DST

A "day" is the **local calendar date in the campaign's timezone**,
computed with `Intl.DateTimeFormat('en-CA', { timeZone })`. Node carries
full IANA data (418 zones, verified), and both DST directions were
checked: 2026-03-08 skips 02:00 local, 2026-11-01 repeats 01:00 local.

A run is eligible when local wall-clock time is inside
`[execution_window_start, execution_window_end)`. A window that does not
exist on a spring-forward day (e.g. 02:00–03:00 in New York) would
otherwise strand a campaign, so window evaluation is done on the
*instant*, not by reconstructing a local timestamp.

### Quota semantics — and what the provider actually allows

Bluesky's documented limits (docs.bsky.app, "Rate Limits"):

- **5,000 points/hour and 35,000 points/day per account.** A CREATE is
  3 points ⇒ **1,666 records/hour, 11,666 records/day.**
- Overall API requests: **3,000 per 5 minutes, limited by IP** — shared
  across Vercel's egress, so this, not the daily budget, is the tighter
  constraint at scale.
- `createSession`: 30 per 5 min, **300 per day per account** — sessions
  must be reused across chunks and refreshed only on 401.

So the maximum operator quota of 1,000/day is ~8.6% of the documented
daily write budget. That is comfortable, and **Signal still does not
promise it**: the docs also say "moderation systems and other
application-specific limits may apply" and that "bulk or spammy
interactions are against the Community Guidelines". The confirmation
screen says so in those terms.

`effectiveDailyQuota = min(` requested, identity's remaining combined
allowance, circuit-breaker cap, provider-signalled cap from the last
429 `)`.

**Which outcomes consume quota** (tested explicitly):

| Outcome | Consumes | Why |
| --- | --- | --- |
| `succeeded` | yes | a record was created |
| `failed_structural` | yes | the attempt was made |
| `retryable` exhausted | yes | attempts were made |
| `already_following` | **no** | no record created; requirement is explicit |
| `protected` / `skipped` | **no** | never attempted |
| `rate_limited` / lease released | **no** | not attempted |

Quota is **not** refilled by substituting extra candidates — a failed
profile does not silently pull another in.

### Flow

```
cron (*/5)  →  dispatcher (idempotent)
                 ├─ global / per-identity kill switch?  → stop
                 ├─ campaign active, inside window?     → else skip
                 ├─ get-or-create run for (campaign, local_date)
                 ├─ compute effectiveDailyQuota
                 └─ worker loop, bounded by:
                      • effective quota remaining
                      • wall-clock budget inside maxDuration
                      • circuit breakers
                    each iteration:
                      claim ≤ MAX_RELATIONSHIP_BATCH_SIZE atomically
                      → process with existing spacing
                      → persist every outcome
                      → release untouched claims
                    return; the next cron tick continues
```

No in-process timer, no self-recursion, no browser involvement. A
deployment mid-run loses at most the in-flight chunk, whose rows return
to `queued` when their lease expires.

---

## C. Assumptions and unresolved risks

**Assumptions**

1. Vercel plan is Pro (confirmed: `list_teams` reports `plan: pro`), so
   `maxDuration = 300` holds and 40 cron jobs are allowed (5 in use
   after this change). On Hobby the platform clamps to 60s — the system
   stays *correct*, just does fewer chunks per tick. Documented.
2. `CRON_SECRET` is already configured (the existing crons depend on it).
3. Reads go to the public AppView and do not consume the PDS budget.

**Unresolved risks**

| Risk | Severity | Handling |
| --- | --- | --- |
| ~~The migration is still unapplied~~ — **RESOLVED 2026-09-11.** The relationship schema is applied in production, real manual follows have been executed against it, and the live campaign page reads the campaign schema. | — | Superseded. The read-failure classifier stays as defence against a *future* unapplied migration, but it no longer describes current production. |
| Vercel egress IP shares the 3,000-req/5-min limit with other tenants | Medium | Honour returned headers; stop on 429 and wait for reset. Cannot be eliminated from our side. |
| Moderation action despite being inside documented limits | Medium | Cannot be prevented technically. Confirmation states it; circuit breakers pause on a falling success rate. |
| Cron delivery skipped entirely (platform incident) | Low | Idempotent dispatcher; the next tick resumes. Quota is per local day, so a missed day is simply a missed day — no catch-up burst. |
| Clock skew between Vercel and Postgres | Low | All lease/expiry comparisons use `now()` **in Postgres**, not application time. |
| A campaign whose window never occurs in its timezone | Low | Validated at creation; DST-skipped windows handled on the instant. |
| Long-tail `retryable` members never terminal | Low | Strict `MAX_ATTEMPTS`; exhausted attempts become terminal and consume quota. |

**Explicitly out of scope / refused:** no anti-detection, no proxy or
credential rotation, no fingerprint spoofing, no randomised masking, no
rate-limit evasion, and **no automated Unfollow** — the campaign system
has no unfollow code path at all, asserted by test.

---

## D. Implementation sequence

1. Migration: tables, indexes, RLS, claiming RPC, additive audit columns.
2. Pure core: quota, calendar/DST, outcome classification, circuit
   breakers — all testable without a database.
3. Repository: workspace-scoped reads/writes, keyset pagination, exact
   counts, RPC wrapper.
4. Import pipeline: bounded streaming from existing candidates/targets.
5. Dispatcher + worker, reusing the existing session lifecycle and
   `processBatchActions` spacing.
6. Cron route + `vercel.json` entry + kill switches.
7. Server actions (create, activate, pause, resume, cancel, change
   quota, import) with the existing authorization gate.
8. UI under Bluesky Relationships; fix the stuck-confirmation defect.
9. Tests: 100k scale, concurrency, scheduler idempotency, RLS negative
   controls, quota matrix, failure policy, mobile layout.
10. Docs: runbook, environment, QA checklist, observability queries.
