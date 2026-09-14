# Bulk Unfollow Campaigns — audit, architecture, and risk analysis

Baseline: `origin/main` @ `4fe8d4d` (PR #194 merged).

This document is deliverables **A–E** of the brief. It is written
before the implementation and is not revised to match what was built;
where the build diverged, the divergence is recorded at the end.

---

## A. Existing-system audit

### A.0 Repository conventions

| File | Status |
| --- | --- |
| `AGENTS.md` | **Does not exist** — neither tracked nor untracked. |
| `CLAUDE.md` | **Does not exist** in the repository. (A user-global `~/.claude/CLAUDE.md` exists but concerns an unrelated SEO plugin.) |
| `CONTRIBUTING.md` | **Does not exist.** |

Conventions are therefore taken from the code and from
`docs/relationships/*`, which is a substantial and unusually candid
body of design documentation: `campaigns-architecture.md`,
`campaigns-hotfix.md` (25 KB of defect post-mortems),
`production-hardening.md`, `negative-controls.md`, `campaigns-runbook.md`,
`campaigns-qa-checklist.md`, `phase-0-audit.md`.

### A.1 What already exists

**The Follow Campaign system is mature and has been hardened through
seven production hotfixes.** It is the architectural baseline and is
reused, not reimplemented.

*Migrations (44 applied, forward-only, none edited after merge):*

| Migration | Contribution |
| --- | --- |
| `20260911000001_bluesky_relationship_actions` | Candidates, target profiles, **`bluesky_relationship_actions`** (permanent audit trail), protection flag, one-active-action partial unique index, frozen-batch trigger |
| `20260911000002_bluesky_follow_campaigns` | Campaigns, members queue, runs, member sources, identity daily usage, kill switches, `claim_bluesky_campaign_members` (`FOR UPDATE SKIP LOCKED`), `ensure_bluesky_campaign_run` |
| `20260911000003_campaign_concurrency_hotfix` | `reserve_bluesky_campaign_quota` (atomic reserve **and** claim), `claim_bluesky_campaign_action`, composite `(id, workspace_id)` tenant FKs, `can_manage_bluesky_campaigns` |
| `20260911000004_campaign_reservation_ownership` | **`bluesky_campaign_quota_reservations`** (owned reservations), **`bluesky_campaign_attempt_ledger`** (append-only, `provider_intent_at` immutable), `fold_bluesky_ledger_outcomes` |
| `20260911000005_campaign_intent_and_lock_order` | **`consume_bluesky_member_quota`** — one transaction, fixed lock order `identity usage → run → reservation → ledger → action`; exact-action folding; `sweep_bluesky_quota_reservations` |
| `20260911000006_campaign_owned_release` | `release_bluesky_campaign_members_owned` — a worker may hand back only what it still holds |
| `20260912000001_campaign_setup_and_scale_import` | Keyset candidate listing, `bluesky_campaign_import_jobs`, `begin/advance_bluesky_campaign_import` |
| `20260912000002_campaign_import_production_hotfix` | Snapshot keyset cursor, `import_bluesky_campaign_member_chunk` |
| `20260912000003_campaign_safeupdate_hotfix` | Compare-and-set recovery |

*Proven primitives this feature reuses verbatim:*

- **Atomic reservation + claim in one transaction** under a fixed lock
  order, with `FOR UPDATE SKIP LOCKED` for member selection.
- **Owned reservations** — a reservation is a row with an identity, not
  a scalar counter inferred from lease status. (The post-mortem for why
  is in `campaigns-hotfix.md`: lease status answers "is anyone holding
  this row", which is a different question from "has this unit been
  spent".)
- **An append-only attempt ledger** whose `provider_intent_at` is set
  in the same transaction that consumes the unit, immediately before
  the provider call, and is never cleared.
- **Settlement by folding the ledger**, never by trusting worker
  in-memory totals.
- **A closed-set claim verdict** (`may_mutate | reconcile_only |
  terminal | denied`) carrying a `MutationPermit` that only the
  permitting branch can produce — so a branch without permission cannot
  reach the provider at all.
- **Reconciliation-only mode**: a possible-but-unconfirmed provider
  mutation is never re-sent; relationship truth is read instead.
- **Per-(campaign, local_date) run uniqueness** as the cron idempotency
  key; Vercel Cron is at-least-once.
- **Dispatch lease** — one dispatcher per campaign-day, because
  "consecutive failures" is a property of a sequence and two
  interleaved workers do not have one.
- **Durable, restartable keyset import** with a snapshot cursor and a
  `source_exhausted` flag; activation refuses while it is false.
- **Kill switches**, global and per-identity, read before any provider
  call and failing closed.

*Provider layer (`atproto-graph.ts`):*

- `deleteFollowRecord({ accessJwt, actorDid, rkey, swapCid })` **already
  exists** and already refuses an empty rkey with a message telling the
  caller to reconcile first. It posts `com.atproto.repo.deleteRecord`
  with `repo`, `collection: app.bsky.graph.follow`, `rkey`, and
  optional `swapRecord`.
- `rkeyFromAtUri` **parses** a provider AT-URI. There is no derivation
  from a subject DID, and the comment records why: observed rkeys in a
  single provider response used incompatible schemes
  (`did_plc_z72i7hdy…` alongside `zP0yDDN2oUGcWA`).
- `getRelationships` returns `followingUri` — the AT-URI of *our* follow
  record — and `resolveRelationship` parses it into `{ uri, rkey }`.
  **This is the authoritative, non-guessed source of the delete target.**
- `getFollows` / `listRecords` — **absent**. Scope "everyone I follow"
  has no provider-backed enumeration today.

*Test infrastructure:*

- `src/test/pg/harness.ts` — PGlite (real PostgreSQL, WASM, single
  backend). Real DDL, constraints, GRANT/REVOKE, RLS.
- `src/test/pg/server-harness.ts` — **`embedded-postgres`: a real
  PostgreSQL server on a loopback port, every connection its own
  backend.** Two-session lock contention is genuinely available.
- Both replay every migration from `supabase/migrations`.

### A.2 What is missing, and what actively blocks Unfollow

1. **There is no unfollow campaign path, by design, asserted by three
   tests.** `dispatcher.test.ts:542` ("this system cannot unfollow"),
   `outcomes.test.ts:242`, `rls-and-authorization.test.ts:419`. These
   assertions are correct today and must be *narrowed to the Follow
   subsystem* rather than deleted — see §D.

2. **The duplicate-action guard does not prevent a Follow/Unfollow
   conflict.** `bluesky_relationship_actions_one_active` is unique on
   `(workspace_id, operator_account_id, subject_did, action_type)`
   where `status in ('pending','running')`. Because `action_type` is
   *in the key*, a pending Follow and a pending Unfollow for the same
   subject from the same identity are **both permitted today**. This is
   the single most important defect the brief asks to close.

3. **The identity daily ceiling is denominated in follows, not
   points.** `IDENTITY_DAILY_FOLLOW_CEILING = 1000` is compared against
   `bluesky_identity_daily_usage.follows_created`. There is no column
   for deletions and no combined envelope.

4. **Campaign statuses lack `building_queue` and `ready`.** The build
   state lives on `bluesky_campaign_import_jobs.status`, not on the
   campaign. The brief requires both as campaign states.

5. **Member statuses lack `already_not_following`**, and `protected` has
   no reason column, so "why was this skipped" cannot be displayed.

6. **There is no operator-managed allowlist.** `bluesky_candidates.
   protected` is per-candidate and per-identity, which does not cover a
   DID that was never imported as a candidate.

### A.3 Verified external limits (fetched 2026-09-14)

From `https://docs.bsky.app/docs/rate-limits` (redirects to
`bsky.network`), read this session — **not** carried over from the
Follow docs:

| Limit | Value | Scope |
| --- | --- | --- |
| Repo write points | **5,000/hour, 35,000/day** | per account (DID) |
| `CREATE` | **3 points** | — |
| `UPDATE` | **2 points** | — |
| **`DELETE`** | **1 point** | — |
| Overall API requests | **3,000 per 5 minutes** | **per IP** |
| `createSession` | 30 per 5 min, **300/day** | per account |

Verbatim caveat, quoted because it governs the ceiling choice:

> "Note that moderation systems and other application-specific limits
> may apply… following other users and 'liking' content both count as
> interactions in the Bluesky app, and bulk or spammy interactions are
> against the Community Guidelines."

**The consequence the Follow subsystem never had to face:** a DELETE
costs **one third** of a CREATE. The provider would permit **35,000
unfollows per day** on points alone. Points are therefore *not* the
binding constraint for Unfollow, and sizing the ceiling from them would
be sizing it from the wrong number.

---

## B. Proposed architecture and state machine

### B.1 Extend, do not fork

The brief prefers extending the generic campaign infrastructure. That
is what is done, with one structural exception.

**Extended (shared with Follow):** `bluesky_follow_campaigns` gains a
`kind` discriminator (`'follow' | 'unfollow'`, default `'follow'`), and
the members / runs / reservations / ledger / import-job tables are used
unchanged. This is what makes the reservation model, the lock order,
the ledger, settlement, the dispatch lease, the sweep and the import
engine apply to Unfollow *as the same code*, already proven by the
existing real-PostgreSQL suites.

**The exception — the Follow dispatcher must never see an Unfollow
campaign.** A `WHERE kind = 'follow'` in TypeScript is not sufficient
protection against the worst failure this system can have (following
tens of thousands of people who were queued to be unfollowed). So the
guarantee is made **three times, structurally**:

1. `list_due_campaigns` filtering by `kind` in the repository.
2. `claim_bluesky_campaign_action` — the Follow path's action-claiming
   RPC, which hardcodes `action_type = 'follow'` — gains a **refusal**
   when the campaign's `kind <> 'follow'`. This is a *narrowing* change
   to a Follow function: it can only ever refuse, never widen.
3. A dedicated negative-control test asserting a `kind='unfollow'`
   campaign is invisible to `dispatchCampaigns` **and** that the follow
   action claim refuses it at the database level.

### B.2 Campaign state machine

```
                    ┌──────────────────────────────────┐
                    ▼                                  │
  draft ──▶ building_queue ──▶ ready ──▶ active ──▶ paused
              │      │                    │  ▲  │        │
              │      │                    │  │  ├──▶ rate_limited ──┘
              │      ▼                    │  │  │      (auto-resume
              │   failed                  │  │  │       after reset)
              │                           │  │  └──▶ reauthorization_required
              │                           │  │              │
              ▼                           │  └──────────────┘  (operator)
          cancelled ◀───────── (any non-terminal) ────────────┘
                                          │
                                          ▼
                                      completed
```

Rules the database enforces, not the UI:

- `draft → building_queue` on the first import call. **The source is
  frozen here**: `begin_bluesky_campaign_import` already refuses a
  source change on an existing job, and activation additionally
  requires `source_exhausted`.
- `building_queue → ready` only when the import job reports
  `source_exhausted AND status='ready'`.
- **`ready → active` is the one explicit operator activation.** Refused
  while `building_queue`, while the job is `failed`, and while
  `source_exhausted` is false.
- `paused` is only ever left by an operator. The rate-limit resume path
  is guarded inside `resume_bluesky_campaign_run` so it can move only a
  `rate_limited` run whose reset has elapsed — **an operator pause is
  never auto-resumed**, which is already proven by an existing test.
- `cancelled` stops future claims. It does **not** re-follow anyone.

### B.3 Member state machine

```
queued ──▶ claimed ──▶ provider_in_flight ──▶ succeeded
   │          │                 │          ├▶ already_not_following (0 quota)
   │          │                 │          ├▶ retryable ──▶ (back to queued)
   │          │                 │          └▶ failed_structural
   │          └──▶ (lease lapses) ──▶ queued
   ├──▶ protected      (0 quota, carries a reason)
   └──▶ cancelled
```

`already_not_following` is a **neutral success**: the operator's intent
("I should not be following this person") is satisfied, no record was
deleted, and **no quota is consumed**.

### B.4 The delete path — exactness over convenience

An unfollow is the deletion of one specific record in the acting
repository. Everything below is about never deleting a different one.

1. **The rkey is never derived.** The only sources are a provider
   AT-URI parsed by `rkeyFromAtUri`, from either the import walk
   (`com.atproto.repo.listRecords` over the acting repo) or a
   relationship read (`getRelationships().followingUri`).
2. **The rkey is re-resolved immediately before intent, and the fresh
   one wins.** A stored rkey may be stale: if the operator unfollowed
   and re-followed between import and execution, the record key
   changed. Deleting the stale key would succeed (deleteRecord is
   idempotent — "or ensure it doesn't exist") while leaving the *live*
   follow in place, and Signal would report an unfollow that did not
   happen. **This is a defect class with a dedicated failing test.**
3. **Ownership is validated as a whole tuple before the request**:
   repository DID == the acting session's DID, collection ==
   `app.bsky.graph.follow`, rkey non-empty and provider-issued,
   plus workspace / campaign / run / member / reservation / action, all
   checked inside `consume_bluesky_unfollow_quota`.
4. **`swapRecord` is sent** whenever a CID is known, so the PDS itself
   compare-and-swaps and refuses if the record has been replaced.
5. **Protection is re-checked immediately before intent**, against
   live state, not against what the import saw.

### B.5 Quota model — and the decision the brief asks for

**Decision: Follow and Unfollow share ONE combined per-identity daily
ceiling, enforced by the database through the counter both already
increment, and Follow goes first.**

Rationale, from the verified limits:

- The provider's budget *is* a single points pool per DID. Two separate
  count-based ceilings would model something the provider does not
  have.
- But points are not the binding risk. A DELETE costs 1 point, so
  35,000 deletes/day is permitted on points alone — far beyond anything
  defensible. The binding risk is the explicitly documented
  moderation/Community-Guidelines exposure of **bulk interaction**,
  which is a judgement, not an arithmetic.

**How it is enforced.** `consume_bluesky_member_quota` — the shared,
unchanged RPC — increments `bluesky_identity_daily_usage.attempts_made`
for BOTH kinds, and `reserve_bluesky_campaign_quota` bounds every new
reservation by it against `IDENTITY_DAILY_MUTATION_CEILING = 1,000`.
No caller performs the coupling, so no caller can forget it. A day
spent following genuinely leaves less room for unfollowing.

**Worst case in provider terms:** 1,000 CREATEs = 3,000 points, which
is 8.6 % of the documented daily budget — the same headroom the Follow
architecture already justified. 1,000 DELETEs is 1,000 points, or
2.9 %. No mix can exceed the former.

**Ordering.** Inside one cron invocation the Follow dispatcher runs
first and the Unfollow dispatcher takes what wall clock remains. If the
identity's budget runs out, the work that does not happen is the
irreversible, publicly visible deletion.

`provider_points_spent` is kept as a **generated column** on the usage
row (`follows_created × 3 + unfollows_deleted × 1`) for operator
transparency. It is displayed; it is not a limit, because the mutation
ceiling always binds first.

*Revised from the first draft of this document, which proposed a
separate 3,000-point envelope as a live limit. Reading
`reserve_bluesky_campaign_quota` showed the coupling already existed
through `attempts_made`; a second limit would have been redundant and
would have added a second place for the two kinds to disagree.*

The full quota chain, minimum-wins, each reported separately to the
operator:

```
effective = min(
  operator requested quota,
  identity remaining (1,000 − attempts_made, both kinds),
  run headroom (effective − attempted − reserved),
  circuit breaker cap,
  provider-signalled cap from the last 429,
  remaining eligible members
)
```

---

## C. Threat, race, and crash analysis

| # | Scenario | Defence | Proven by |
| --- | --- | --- | --- |
| C1 | Follow dispatcher picks up an Unfollow campaign and **follows** the queue | `kind` filter + **database refusal** in `claim_bluesky_campaign_action` + negative control | `follow-unfollow-isolation.pg.test` |
| C2 | Concurrent Follow and Unfollow campaigns fight over one subject | **Total** partial unique index on `(workspace, identity, subject_did)` for unresolved actions, *without* `action_type` | `follow-unfollow-conflict.pg.test` |
| C3 | Two workers claim the same member | `FOR UPDATE SKIP LOCKED` inside the reservation RPC | existing + new two-session test |
| C4 | Two workers exceed the identity's day | Row-locked reservation, fixed lock order, owned reservation rows | two-session test |
| C5 | Crash **before** provider intent | No ledger intent, no in-flight marker → member returns to `queued`; next worker sends **exactly one** first delete | `unfollow-crash-recovery` |
| C6 | Crash **after** provider intent | `provider_intent_at` is durable and immutable → reconciliation-only; **zero** deletes sent | `unfollow-crash-recovery` |
| C7 | Crash after a successful provider response, before settlement | Settlement folds the ledger, not worker memory; `counted_at` makes folding idempotent | `unfollow-settlement` |
| C8 | **Stale rkey** — operator re-followed between import and execution | Re-resolve immediately before intent; fresh rkey wins; mismatch is recorded | `unfollow-record-identity` |
| C9 | Guessed rkey | `deleteFollowRecord` refuses empty; no derivation exists; test asserts no call site constructs one | `unfollow-record-identity` |
| C10 | Delete aimed at another repository or collection | Whole-tuple validation; `repo` is the session's own DID | `unfollow-record-identity` |
| C11 | Ambiguous provider response | `reconciliation_required` + durable backoff; never re-sent | `unfollow-reconciliation` |
| C12 | One ambiguous member monopolises the tick | Reconciliation backoff (`RECONCILIATION_BACKOFF_MS`, already on main) keeps it out of the same pass | `unfollow-reconciliation` |
| C13 | Quota exhausted but reconciliation outstanding | Reservation RPC hands back reconciliation work regardless of headroom | `unfollow-quota` |
| C14 | Auth expiry mid-chunk | At most one refresh, one retry, **below** the consume line — no second action/intent/reservation/unit | `unfollow-auth-refresh` |
| C15 | Duplicate cron delivery | `unique (campaign_id, local_date)` + dispatch lease | existing, extended |
| C16 | Duplicate settlement | Reservation `status` CAS + ledger `counted_at` | existing, extended |
| C17 | Unknown RPC verdict | Closed verdict union + `never` exhaustiveness; unknown ⇒ deny | `unfollow-permit` |
| C18 | Stale worker releases a new worker's lease | `release_bluesky_campaign_members_owned` proves ownership | existing |
| C19 | Cancelled confirmation dispatches | The `<form>` does not exist until the final confirmation state | `unfollow-confirmation` |
| C20 | Secret leakage | Only provider `message`/`errorCode` persisted; no header, token or cookie reaches a column, log, or serialized result | `unfollow-secret-hygiene` |
| C21 | Campaign widens after import | Source frozen by the import job; activation requires `source_exhausted` | `unfollow-source-immutability` |
| C22 | Protected profile unfollowed because state changed after import | Protection re-checked immediately before intent | `unfollow-protection` |
| C23 | Acting identity unfollows itself | Refused at import **and** at intent | `unfollow-protection` |

---

## D. Migration and deployment plan

Forward-only. No merged migration is edited.

| Version | Name | Contents |
| --- | --- | --- |
| `20260914000001` | `bluesky_unfollow_campaigns` | `kind` discriminator; new member/campaign statuses; `unfollow_record_uri/rkey/cid`; protection reason; `bluesky_unfollow_allowlist`; `unfollows_deleted` + point accounting on identity usage; **the total conflict index**; `consume_bluesky_unfollow_quota`; `claim_bluesky_unfollow_action`; Follow-path refusal guard; RLS + grants for every new object |

Deployment order (nothing is applied by this change):

1. Merge the PR. **Do not deploy yet.**
2. Apply `20260914000001` to production Postgres. It is additive and
   idempotent; existing rows default to `kind='follow'`.
3. Verify: `kind` defaults, the conflict index exists, the four new RPCs
   exist, `has_function_privilege('service_role', …)` is true and
   `authenticated`/`anon`/`PUBLIC` is false.
4. Deploy the application.
5. `vercel.json` is **unchanged** — the existing
   `/api/campaigns/bluesky/tick` cron dispatches both kinds.
6. Canary (§ runbook), operator-supervised, never automated.

Rollback is roll-forward: a new migration. The feature is disabled by
the per-identity kill switch, which needs no deploy.

---

## E. The tests that will prove the design

35 requirements from the brief, mapped to files. Every real-PostgreSQL
assertion runs against `embedded-postgres` (multi-backend) where
multi-session behaviour is claimed, and PGlite only for DDL, grants and
RLS — never presented as proof of concurrency.

| # | Requirement | File |
| --- | --- | --- |
| 1 | Queue construction with 100,000 members | `unfollow-scale.test.ts` |
| 2 | All members imported exactly once (keyset) | `unfollow-scale.test.ts` |
| 3 | Identical timestamps, deterministic tie-break | `unfollow-scale.test.ts` |
| 4 | Concurrent queue builders | `unfollow-import.pg.test.ts` |
| 5 | Source immutability | `unfollow-import.pg.test.ts` |
| 6 | Activation refused while building/failed | `unfollow-setup-flow.test.ts` |
| 7 | Two workers race for one member | `unfollow-two-session.pg.test.ts` |
| 8 | Two workers race for one identity quota | `unfollow-two-session.pg.test.ts` |
| 9 | Real two-session lock contention | `unfollow-two-session.pg.test.ts` |
| 10 | Crash before intent ⇒ exactly one first delete | `unfollow-crash-recovery.test.ts` |
| 11 | Crash after intent ⇒ zero deletes, reconcile | `unfollow-crash-recovery.test.ts` |
| 12 | Crash after response, before settlement | `unfollow-crash-recovery.test.ts` |
| 13 | Missing record before intent ⇒ `already_not_following`, zero quota | `unfollow-worker.test.ts` |
| 14 | Exact URI/rkey ownership validation | `unfollow-record-identity.test.ts` |
| 15 | No guessed or stale rkey | `unfollow-record-identity.test.ts` |
| 16 | Follow/Unfollow conflict | `unfollow-conflict.pg.test.ts` |
| 17 | Lease expiry and reclaim | `unfollow-two-session.pg.test.ts` |
| 18 | Stale worker cannot release a new lease | `unfollow-two-session.pg.test.ts` |
| 19 | Duplicate cron delivery | `unfollow-dispatcher.test.ts` |
| 20 | Duplicate settlement | `unfollow-quota.pg.test.ts` |
| 21 | Unknown RPC verdict ⇒ zero provider calls | `unfollow-worker.test.ts` |
| 22 | Auth expiry ⇒ one refresh, no double accounting | `unfollow-worker.test.ts` |
| 23 | Rate-limit pause and same-run resume | `unfollow-dispatcher.test.ts` |
| 24 | Operator pause never auto-resumed | `unfollow-dispatcher.test.ts` |
| 25 | Ambiguous ⇒ reconciliation reads, zero re-deletes | `unfollow-worker.test.ts` |
| 26 | Slow reconciliation cannot monopolise a tick | `unfollow-dispatcher.test.ts` |
| 27 | Quota exhausted, reconciliation still proceeds | `unfollow-dispatcher.test.ts` |
| 28 | Identity-wide ceiling across campaigns | `unfollow-quota.pg.test.ts` |
| 29 | Local date and window across DST | `unfollow-dispatcher.test.ts` |
| 30 | RLS and RPC privileges on real PostgreSQL | `unfollow-rls.pg.test.ts` |
| 31 | No secret in logs, errors, UI, serialized results | `unfollow-secret-hygiene.test.ts` |
| 32 | Responsive at 320/375/390/768/1280, 44 px targets | `unfollow-mobile-layout.test.ts` + Chromium QA |
| 33 | Dry run makes zero Bluesky mutations | `unfollow-worker.test.ts` |
| 34 | Cancelled confirmation ⇒ zero server-action calls | `unfollow-confirmation.test.ts` |
| 35 | Cancelled campaign creates no future intent | `unfollow-dispatcher.test.ts` |

Each of C1, C2, C5, C6, C8, C13, C17 and C22 is **reproduced as a
failing negative control before the fix**, and the corresponding test
is **mutation-checked** by restoring the defect and confirming the
failure mode is the intended one.

---

## F. Where the build diverged from this plan

Recorded rather than revised away.

1. **Quota model** — see the note in §B.5. One shared ceiling through
   the existing counter, not a second point envelope.

2. **`stop_run`, not `stop_campaign`, for a 429.** My first version
   moved the campaign to `rate_limited` via `stop_campaign`; the
   dispatcher lists only the statuses it is told to, so the campaign
   dropped out of the listing and could never resume. Caught by
   `dispatcher.pg.test.ts`. The state is kept and made listable.

3. **The retry backoff is computed by the database.** The plan had the
   worker write `next_attempt_at` from its own clock. That is one side
   of a comparison PostgreSQL performs against `now()`; the two clocks
   disagreeing turned the backoff into no backoff at all. Added
   `defer_bluesky_campaign_member`.

4. **`claim_bluesky_campaign_action` was first rebuilt from the WRONG
   version.** The migration uses `create or replace` on this deployed
   Follow function. The first draft reproduced the body from
   `20260911000003`, not the corrected one from `20260911000005`, and
   so reintroduced the two defects that migration fixed: the in-flight
   marker stamped at claim time, and a marker-less pending row treated
   as reconciliation. Three deployed Follow tests on real PostgreSQL —
   `intent-and-locking.pg.test.ts`, `rpc-behaviour.pg.test.ts` — failed
   and named both. The function is now the 005 body plus the kind guard
   and the conflict-handler correction, and the behavioural diff
   against 005 is exactly those two additions. Two of my own tests had
   encoded the wrong behaviour and were corrected. This is the drift
   risk the migration's own comment warns about; it happened anyway,
   and the reason it did not ship is that the Follow subsystem's
   real-database tests exist.

5. **A mutation control that should have failed, didn't.** Deleting the
   conflict index from the migration left every behavioural test green,
   because the reproduction test recreated the index during its own
   cleanup. Fixed by capturing and restoring the *shipped* definition
   and by asserting the migration creates it before any test touches
   it.

6. **Two exemptions turned out to be currently unreachable** — the
   worker's `reconciliationOnly` quota bypass and the dispatcher's
   per-pass visit guard. Mutation controls confirmed removing either
   changes nothing observable today. Both are kept as documented floors
   under the primary defences, with comments that say so rather than
   claiming they bite.
