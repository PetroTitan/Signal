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
| Has the hotfix migration been applied to production? | **No.** `20260911000003` has been executed only against a real PostgreSQL instance in the test harness. |
| Is this hotfix deployed? | **No.** Not merged, not deployed. |
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

### 1. Quota reservation was not atomic

The dispatcher read usage, claimed a chunk, and incremented counters
*after* the chunk finished. Two dispatchers both read "0 used today",
both computed the full quota, and both proceeded.

The old test asserted the two workers claimed **disjoint** members. That
was true and irrelevant: disjointness bounds *who* touches which row,
not *how many* follows happen. Two dispatchers at a quota of 100
performed 200 follows with no member followed twice, and the test stayed
green.

Fixed by `reserve_bluesky_campaign_quota`, which under a row lock
reserves quota and claims exactly the reserved number in one
transaction, and by `apply_bluesky_run_outcome`, which writes every
counter as a **delta** and consumes the reservation in the same
statement. `reserved_count` is tracked separately from `attempted_count`
on both the run and the identity's daily usage.

The assertion is now on **provider calls**, which is the number that
reaches real people.

### 2. Mutation idempotency was decorative

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

### 6. A 429 forfeited the rest of the day

The dispatcher returned early on any run not in `running`, so the first
rate limit of the day ended the day — even though Bluesky's write budget
resets hourly and the reset usually falls on the same local date.

Remaining / reset / retry-after are now persisted, `next_run_at` is
scheduled no earlier than the reset (and inside the execution window),
and `resume_bluesky_campaign_run` returns the **same** run to `running`
once the reset has elapsed. It is guarded so that an operator pause is
never undone and no second run is opened for the day — a second run
would hand the day a second quota.

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

**Known limitation:** PGlite is a single backend. It cannot hold two
simultaneous sessions, so it proves *constraints, permissions, RLS and
RPC behaviour* but cannot demonstrate two genuinely parallel
transactions contending for a lock. The concurrency proof therefore runs
against the fake, where two complete `dispatchCampaigns` calls are
interleaved and the assertion is on provider calls. The two halves are
complementary: PGlite proves the SQL is what we think it is, the fake
proves the dispatcher uses it correctly under contention.

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

### The gates

| Gate | Where |
| --- | --- |
| Migrations + RPCs execute on real PostgreSQL | `src/test/pg/migration.pg.test.ts` (16) |
| RPC behaviour under the production role | `src/test/pg/rpc-behaviour.pg.test.ts` (16) |
| RLS for owner / admin / member across two workspaces | `src/test/pg/rls.pg.test.ts` (17) |
| Two complete dispatchers ≤ quota, measured in provider calls | `quota-concurrency.test.ts` (10) |
| Crash after provider success → zero further mutations | `crash-recovery.test.ts` (7) |
| Same-day 429 recovery | `rate-limit-recovery.test.ts` (7) |
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
