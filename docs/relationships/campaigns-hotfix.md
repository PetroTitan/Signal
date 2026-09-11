# Bluesky Follow Campaigns — concurrency hotfix

Forward-only. Follows PR #181 (merged, deployed as `d955e88`).

This document states what is **true in production right now**, what is
**ready in code**, and the seven defects this hotfix closes. Those three
are reported separately on purpose: PR #181's own writeup blurred them,
and the most serious defect below was invisible precisely because "the
tests pass" was read as "the feature works".

---

## 1. Production state vs code readiness

These are different questions and are answered separately.

| Question | Answer |
| --- | --- |
| Is the relationship migration applied in production? | **Yes.** Applied before this hotfix. The claim that it is unapplied was stale and has been corrected in `production-hardening.md` and `campaigns-architecture.md`. |
| Has production performed real relationship mutations? | **Yes** — real, operator-initiated manual follows have been executed against the live schema. |
| Is the campaign schema live? | **Yes.** The campaign page reads the new campaign tables in production. |
| Is PR #181 merged and deployed? | **Yes** — `d955e88`. |
| Is PR #182 merged? | **Yes** — merged as `ba91f41` on 2026-09-11. It carries `20260911000003` AND two P0 defects found in review afterwards (see §2.1 and §2.2). |
| Has `20260911000003` been applied to production? | **Unverified from here.** It is on main and may be applied at any time, which is why the P0 repair is a SEPARATE migration (`20260911000004`) rather than an edit. |
| Has `20260911000004` been applied to production? | **No.** Executed only against real PostgreSQL in the test harnesses. |
| Is the P0 repair merged or deployed? | **No.** |
| Could the deployed campaign feature actually have run? | **No** — see defect 3. `service_role` held no EXECUTE on any worker RPC, so the dispatcher could not claim a single member. The deployed feature was inert. |

**Code readiness** is a separate claim: the code in this branch passes
typecheck, lint, the full suite, and a production build, and the
behaviours below are proven by tests that were each verified to fail
against the pre-hotfix behaviour. That is not the same as "verified in
production", and nothing here should be read as the latter.

---

## 2. What was wrong

Every defect below was reproduced against the merged code before any
fix was written. None was accepted on description.

### 1. Quota reservation was not atomic — and the first fix was still wrong

The dispatcher read usage, claimed a chunk, and incremented counters
*after* the chunk finished. Two dispatchers both read "0 used today",
both computed the full quota, and both proceeded.

The old test asserted the two workers claimed **disjoint** members. That
was true and irrelevant: disjointness bounds *who* touches which row,
not *how many* follows happen. Two dispatchers at a quota of 100
performed 200 follows with no member followed twice, and the test stayed
green.

The first version of this hotfix replaced that with a scalar
`reserved_count` reconciled against member LEASE status. That was still
wrong, and the window is narrow enough to be worth spelling out:

```
A reserves 20   → reserved_count = 20
A finishes all 20 members, clearing each lease in persist()
── here ──      → 0 live leases, and the run counters are still 0
B reserves      → concludes reserved_count "drifted", resets it to 0,
                  and finds the whole day's quota available again
B reserves 20   → reserved_count = 20 (B's)
A settles       → consumes 20, which is now B's reservation
```

The day goes over its limit and both workers believe they behaved.
Lease status answers "is anyone holding this row", which is a different
question from "is this quota spent".

So a reservation is now a **row with an identity**
(`bluesky_campaign_quota_reservations`), every claimed member names the
reservation that paid for it, and outstanding quota is the sum over
`open` and `held` reservations — never inferred from a lease.
Settlement quotes the reservation ID back, so
`apply_bluesky_run_outcome` can verify ownership, apply the deltas
exactly once, and treat a duplicate as a no-op. A late worker cannot
consume a reservation that is not its own.

### The third attempt: quota is spent per member, at provider intent

Owning the reservation was necessary and still not sufficient. The
second design released a lapsed reservation when no *unresolved*
in-flight action remained under it — and `provider_in_flight_at` is
cleared on every terminal path. So a worker that followed four people
and then died before settling left those four attempts recorded
nowhere: the run counters were untouched, the members looked finished,
and the sweep concluded nothing could have reached the provider and
returned the whole reservation to the pool. A real-Postgres control
measured **104 available attempts against a quota of 100**.

`provider_in_flight_at` cannot answer this. It says "is a mutation in
flight right now", not "did this member ever reach the provider", and
only the second question bounds a day.

So quota is now consumed **one member at a time, immediately before
`createRecord`**, in its own transaction:

- an immutable `provider_intent_at` is stamped on a ledger row that is
  never deleted and cannot be edited (a trigger enforces it);
- the run's and the identity's attempt counters go up by one;
- the unit comes off the reservation.

A crash can therefore lose the **outcome** of an attempt, never the
fact that it was made. What remains on a reservation is, by
construction, only units that never reached provider intent — so the
sweep can release them freely, and the question it used to ask is gone.

Recovery reads the same durable rows: `fold_bluesky_ledger_outcomes`
aggregates the ledger against the action rows, and is called by both
settlement and the crash sweep, idempotently through `counted_at`.
Settlement accepts **no chunk totals at all** — a worker that dies has
none — and validates the whole tenant tuple (workspace, campaign, run,
identity, usage date), because each of those is a different budget.

An attempt whose outcome is never learned counts as an attempt and as
no success: unknown is not optimism, and its unit is never returned.

Reconciling a member costs nothing, because its unit was already spent.
So reconciliation claims run **regardless of headroom** — requiring
headroom would deadlock exactly when it matters, a campaign that has
spent its whole quota being unable to claim the one member whose
outcome is still unknown. And a day whose quota is exhausted but which
still has unresolved actions now comes back shortly rather than closing
until tomorrow.

The assertion is now on **provider calls**, which is the number that
reaches real people.

### 2. Mutation idempotency was decorative — and "terminal" meant "succeeded"

The worker never inserted a `bluesky_relationship_actions` row. The
campaign-member unique index therefore guarded nothing, and campaign
activity was missing from History entirely.

Now every provider mutation is preceded by a durable claimed row linked
to campaign, run and member, with an explicit state machine:

```
reserved → provider_in_flight → succeeded | failed | ambiguous
```

A lease reclaimed while `provider_in_flight_at` is set enters
**reconciliation-only mode**: it reads relationship truth and never
calls `createRecord` again. If truth is also unavailable the action
stays `reconciliation_required` — unknown on top of unknown is the
strongest possible reason not to send.

The first version of this hotfix then threw that away. The claim RPC
treats `succeeded`, `failed` **and** `reconciliation_required` as
terminal, and the worker mapped every terminal claim to member status
`succeeded`. So a member whose follow was never confirmed — or which
structurally failed — was reported to the operator as followed, and the
campaign counted it as done.

That is the worst failure mode this feature has: a lie about a public
action taken in the operator's name, invisible because everything
downstream agrees. The worker now branches on `existingStatus`:

| Action status | Member outcome |
| --- | --- |
| `succeeded` | `succeeded` — confirmed by a previous pass |
| `failed` | `failed_structural` — never reported as a follow |
| `reconciliation_required` | reconciliation-only; resolves **only** when Bluesky confirms the follow |

A reconciliation pass also consumes neither an attempt nor a unit of
quota. Spending an attempt would eventually exhaust
`MAX_MEMBER_ATTEMPTS` and turn an *unresolved* member into
`failed_structural` without a single request having been made — a false
terminal state reached by counting alone.

### 3. The RPCs were not executable by the worker (**this is the big one**)

PR #181 revoked EXECUTE from `PUBLIC`, `anon` and `authenticated` — 12
revokes — and granted it to nobody. The worker runs as `service_role`.

So the deployed feature could not claim a member, could not open a run,
and could not record usage. It was inert, and no test caught it because
the fake DB has no permission model at all.

The hotfix grants EXECUTE on each worker RPC to `service_role`
explicitly, and a real-PostgreSQL test asserts
`has_function_privilege` is true for `service_role` and **false** for
`anon` and `authenticated` on all nine functions.

### 4. Tenant integrity relied on UUID secrecy

Cross-tenant references were prevented only by server-action filtering.
Composite foreign keys over `(id, workspace_id)` now make a campaign
whose workspace disagrees with its identity, members, runs, sources or
target profiles unrepresentable, and RLS refuses direct PostgREST writes
from roles without `connect_platforms`.

### 5. Kill switches could not be upserted

The table carried two **partial** unique indexes. `ON CONFLICT` cannot
infer a partial index, so the workspace-global switch's upsert never
matched: a second engage raised a duplicate-key error instead of
updating. A kill switch that throws when you engage it twice is not a
kill switch.

Replaced with a generated `identity_key` column (the operator id, or the
nil UUID for the global row) under one total unique index. Failure
remains fail-closed.

### 6a. The consecutive-failure breaker could not count

"Consecutive" is a property of a SEQUENCE, and two interleaved workers
do not have one: both read 3 failures, both write 4, and a breaker set
to trip at 5 never trips while eight follows in a row fail. No
arithmetic fixes that.

So a dispatcher pass is serialised per campaign-day by a lease on the
run (`acquire_bluesky_run_dispatch_lease`). A lease rather than a lock
because the holder is a serverless function that can vanish without
releasing anything. Losing the race is a normal outcome, not an error —
another tick already has the campaign.

This is the FIRST line of defence. The reservation system is the
second, and it is what has to hold when a pass outlives its lease or the
platform kills and replaces a function mid-chunk.

### 6b. A 429 forfeited the rest of the day

The dispatcher returned early on any run not in `running`, so the first
rate limit of the day ended the day — even though Bluesky's write budget
resets hourly and the reset usually falls on the same local date.

Remaining / reset / retry-after are now persisted, `next_run_at` is
scheduled no earlier than the reset (and inside the execution window),
and `resume_bluesky_campaign_run` returns the **same** run to `running`
once the reset has elapsed. It is guarded so that an operator pause is
never undone and no second run is opened for the day — a second run
would hand the day a second quota.

### 6c. A quota exhausted mid-pass never closed the day

The dispatcher decided whether to finish the run from a `quotaRemaining`
figure computed BEFORE the chunk loop. That figure is stale the moment
any chunk runs, so a campaign that spent its quota during the pass left
its run open and `next_run_at` unchanged — and the dispatcher woke on it
every five minutes until midnight, reserving nothing each time.

`reserve_bluesky_campaign_quota` now reports WHY it granted nothing
(`quota_exhausted`, `identity_exhausted`, `queue_empty`,
`run_not_running`, …), and the caller acts on the reason rather than on
a pre-loop number.

### 7. Stale production claims

Corrected; see section 1.

---

## 3. How this was proven

### Real PostgreSQL, not only the fake

The fake DB reproduces the RPCs' *logic*; it cannot reproduce DDL,
constraints, roles, GRANT/REVOKE or RLS — which is exactly where
defects 3, 4 and 5 lived. No Docker daemon, `psql`, Postgres binaries or
Supabase CLI exist on this machine, so the suites run **PGlite**
(`@electric-sql/pglite`): genuine PostgreSQL 18.3 compiled to WASM.

`src/test/pg/harness.ts` replays **all 37 migrations exactly as
shipped**, against a Supabase-shaped prelude (the `auth` and `storage`
schemas, `auth.uid()`, and the `anon` / `authenticated` / `service_role`
roles). Nothing in `supabase/migrations/` is edited to make it apply.

**PGlite's limit, and how it is now covered.** PGlite runs a single
backend: two simultaneous sessions do not exist, so a lock held by one
transaction can never be observed blocking another. That is structural,
not configuration, and it means PGlite cannot prove the single most
important property here.

So there is a second real-Postgres harness. `embedded-postgres`
downloads the official PostgreSQL binaries and runs an ordinary server
on a loopback port — no Docker, no system install — and every connection
is a real backend. `src/test/pg/two-session-concurrency.pg.test.ts`
opens several and proves, among other things, that the second session
genuinely BLOCKS on the first's row lock (the premise everything else
rests on), that four concurrent backends reserving in a loop hand out
exactly the quota and no more, that three backends settling the same
reservation produce exactly one settlement, and that a late settle
cannot touch a reservation opened after it.

That suite immediately earned its place: it caught two runtime defects
in this migration that no PGlite test executed — an OUT parameter that
shadowed the column it was updating (`attempted_count`), which plpgsql
rejects as ambiguous only when the function is CALLED, and an `update`
against a column that does not exist on `bluesky_identity_daily_usage`.
Both would have reached production as a failing RPC.

Both harnesses share one Supabase prelude (`src/test/pg/supabase-prelude.ts`).
They did not at first, the copies drifted, and a migration that applied
in one failed in the other.

Two near-misses are worth recording, because both were tests that passed
for the wrong reason:

- **`set local role` is discarded by PGlite**, which auto-commits each
  statement. Every RLS test ran as superuser and passed without RLS ever
  applying. Fixed by session-scope `set role` plus
  `set_config(..., false)`.
- **The fake evaluated `now()` against the machine's wall clock**, not
  the injected `nowIso`. The rate-limit test "does not resume before the
  reset" was therefore answering a question about the hour the suite was
  run. The fake now has a pinned database clock.
- **The interleaving test never interleaved.** Worker A holds the
  dispatch lease, so worker B was turned away at the door and the
  reservation layer was never exercised — the test passed while proving
  nothing about the thing it was written for. It now lapses A's lease
  explicitly, and the lease's own exclusion is asserted separately.

### The gates

| Gate | Where |
| --- | --- |
| Migrations + RPCs execute on real PostgreSQL | `src/test/pg/migration.pg.test.ts` (16) |
| RPC behaviour under the production role | `src/test/pg/rpc-behaviour.pg.test.ts` (16) |
| RLS for owner / admin / member across two workspaces | `src/test/pg/rls.pg.test.ts` (17) |
| Two complete dispatchers ≤ quota, measured in provider calls | `quota-concurrency.test.ts` (10) |
| Crash after provider success → zero further mutations | `crash-recovery.test.ts` (7) |
| Same-day 429 recovery | `rate-limit-recovery.test.ts` (7) |
| Crash between per-member work and settlement | `crash-accounting.pg.test.ts` (9, real Postgres) |
| Two REAL sessions contending for one quota | `two-session-concurrency.pg.test.ts` (7) |
| Deterministic A-reserves / A-unsettled / B-reserves interleaving | `reservation-interleaving.test.ts` (9) |
| Three passes over an unconfirmable follow | `reconciliation-terminal.test.ts` (5) |
| Kill-switch engage / update / release on PostgreSQL | `migration.pg.test.ts` |
| Campaign actions visible in History | `quota-concurrency.test.ts` |

Each new assertion was mutation-checked: the fix was reverted and the
test confirmed to fail. A test that has never failed has not been shown
to test anything.

---

## 4. Deployment order

The migration must be applied **before** this code is deployed. It is
additive, idempotent and forward-only, but the code depends on the new
RPCs and on the `service_role` grants.

Applying the migration to a deployment still running `d955e88` is safe
on its own: it only adds columns, functions, constraints and grants. It
would in fact make the *currently deployed* feature able to run for the
first time — which is a reason to apply it and deploy together rather
than leaving a window where the old dispatcher can suddenly claim
members without the reservation logic.

Neither step has been performed.
