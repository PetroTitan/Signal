# Incident 2026-09-15 — "webmasterid-auto-300": a routine token expiry stopped a campaign, and a successful refresh did not bring it back

Identity `@webmasterid.bsky.social`. Campaign `cdbb2b76-998c-4cdf-a235-78f629eebc9a`
(`webmasterid-auto-300`); sibling campaign on the same identity
`0b13dce0-7aae-4395-be98-8e1b4b589412` (`WebmasterID 1-3`).

**Nothing in this document was executed against production.** Every
reproduction ran against the shipped migrations on a local PostgreSQL
(PGlite for single-backend scenarios, embedded PostgreSQL for
two-session ones) with a provider double. No follow or unfollow was
performed. Production logs and the production database were not
available to this work (the Vercel connector does not see the Signal
project; the Supabase connector was not authorised), so the timeline
below is the operator's evidence plus what the code can and cannot
produce.

Baseline `origin/main` = `946019c` (PR #197 merged). Branch
`fix/identity-session-coordinator`.

---

## 1. What production showed

| Observation | Value |
| --- | --- |
| Campaign | `reauthorization_required`, `next_run_at` 13:00:47Z |
| Today's run | started 13:00:48Z, last chunk 13:01:08Z, **`paused`**, `last_error_code = reauthorization_required` |
| Rejected action | `pending`, `provider_error_code = ExpiredToken`, `provider_in_flight_at` null |
| 13:40:50Z | identity refreshed successfully by another path: `platform_connections` connected/healthy, `metadata.last_message = "Session refreshed for webmasterid.bsky.social."`, `growth_accounts.connection_status = connected` |
| Afterwards | campaign still `reauthorization_required`, run still `paused`, no chunk, `last_dispatched_at` advancing on every tick |

The pending shape is right: the provider refused before writing, no
duplicate mutation can be inferred, and the member is owed a retry.
Everything after 13:01 is wrong.

## 2. Root causes

### RC1 (confirmed) — nothing serialised the refresh across the workers that share an identity, and a stale failure overwrote a newer success

Access and refresh tokens belong to the identity, and Bluesky refresh
tokens are single-use: the first presentation rotates the token and
every later presentation of the same token is refused with HTTP 400.
Four independent code paths each spent that token on their own: the
Follow worker, the Unfollow worker (both via `performRefresh` in
`session.server.ts`), the publishing orchestrator (its own copy of the
same dance, on the same `*/5` cron), and the operator's "Check account
access" button. None of them held a lock, and none of them checked
whether the stored pair had changed since they read it.

Whoever reached Bluesky second was refused — and `markExpired` then
wrote `expired` to `platform_connections` **and** `growth_accounts`,
over a freshly stored, valid pair. Reproduced as scenario C in
`incident-2026-09-15.pg.test.ts`: on `origin/main` the identity ends
`expired`/`expired` while the row holds `jwt-NEW`/`refresh-2`, the
campaign `reauthorization_required`, the run `paused`, with exactly one
provider refresh call.

The 20-second chunk (13:00:48 → 13:01:08) says the access token was
valid at the start of the chunk and aged out mid-chunk; the refresh
that followed lost to another presentation of the same refresh token.
Which peer won cannot be established without logs: the sibling campaign
in a concurrent (duplicate) delivery, the publisher's tick at the same
minute, or the button. The fix makes the question moot.

### RC2 (confirmed) — a successful refresh did not recover the identity mirror, and recovery gated on the mirror

`performRefresh` on success wrote `connected` to `platform_connections`
only; `markExpired` on failure wrote `expired` to both tables. Campaign
recovery (`recoverReauthorizedCampaigns`) checked
`growth_accounts.connection_status === 'connected'` first. After one
stale failure, therefore, every later successful refresh through the
shared resolver — the campaign worker, "Check account access" — left
the mirror `expired` and recovery never ran. Reproduced as scenario D:
on `origin/main`, after a successful "Check account access" refresh
(`Session refreshed for …`, connection connected/healthy), the next
delivery leaves the campaign `reauthorization_required` and the run
`paused`.

The operator's evidence says the mirror read `connected` at 13:40:50.
The code cannot produce `connected` on the mirror through a refresh;
it can through an App-Password reconnect, which writes "Connected as",
not "Session refreshed for". Either the two readings were taken at
different moments, or recovery failed inside one of its silent
`continue` branches (RC3). Both are closed by the redesign.

### RC3 (confirmed) — recovery was per campaign, probe-based, and not atomic with the refresh that proved the session

The refresh that proved the session worked and the campaign recovery
were separate operations in separate transactions, joined only by a
`growth_accounts` flag and a later `getSession` probe with three
silent `continue` paths. There was no instant at which "identity
healthy" and "campaigns recovered" were guaranteed to be true together.

### RC4 (confirmed) — `last_dispatched_at` advanced for zero work

`dispatchFairly` stamped the campaign before calling the dispatcher,
before knowing whether it held the run's lease or a usable session.
A campaign that could not be served was recorded as served and moved
behind every other campaign on every tick. Reproduced as the third
scenario: three ticks over a blocked campaign advance the stamp on
`origin/main`.

### RC5 (confirmed) — one run state for two different things

An operator's pause and the system's authentication stop both left the
run `paused`, told apart only by `last_error_code`.

### RC6 (confirmed) — transient refresh failures were treated as revocation

A network error or a 5xx on `refreshSession` took the same
`markExpired` path as a rejected token.

## 3. The exact interleaving (scenario B, proven on two real backends)

```
worker A (campaign 1)                 worker B (campaign 2)              database
─────────────────────                 ─────────────────────              ────────
createRecord(jwt-OLD) → 400 ExpiredToken
                                      createRecord(jwt-OLD) → 400 ExpiredToken
acquire lease(observed gen 5) ─────────────────────────────────────────▶ acquired (gen 5, owner A)
refreshSession(refresh-1) [in flight]
                                      acquire lease(observed gen 5) ───▶ busy (A, expires +30 s)
                                      sleep 250 ms, ask again … busy …
provider answers jwt-NEW/refresh-2
commit(expected gen 5, blobs) ────────────────────────────────────────▶ gen 6, connected/healthy,
                                                                        mirror connected, lease cleared,
                                                                        campaigns of identity recovered
retry createRecord(jwt-NEW) → 200
                                      acquire lease(observed gen 5) ───▶ reload (stored gen 6 ≠ 5)
                                      read tokens → jwt-NEW (gen 6)
                                      retry createRecord(jwt-NEW) → 200
```

One `refreshSession`, ever. The stale variant (scenario C): a writer
that does not take the lease — the App-Password reconnect — bumps the
generation by trigger; A's refresh is refused; A's `fail(expected gen
5)` finds gen 6 and is refused with `generation_moved`; A reloads gen 6
and continues. The identity is never marked.

## 4. What changed

### Database — `20260917000002_identity_session_coordinator.sql` (forward-only, idempotent)

| Item | Detail |
| --- | --- |
| `platform_connections.token_generation bigint not null default 0` | Bumped by a `before update` trigger whenever either token column changes and the writer did not move it. Never decreases. The compare-and-swap key. |
| `platform_connections.refresh_lease_owner`, `refresh_lease_expires_at` | The per-identity refresh lease. Expires on its own. |
| `bluesky_follow_campaign_runs.status` | CHECK widened with `waiting_for_auth`. |
| `bluesky_follow_campaigns_reauth_idx` | Partial index for the recovery scan. |
| `acquire_bluesky_refresh_lease(ws, account, owner, observed_generation, lease_seconds)` | `acquired` / `reload` / `busy` / `reauthorization_required` / `not_connected`. Row-locks the identity. |
| `commit_bluesky_refreshed_session(ws, account, owner, expected_generation, access_enc, refresh_enc, did, handle, message, now)` | CAS on the generation; persists the pair, generation+1, connected/healthy, mirrors `growth_accounts`, **recovers every campaign and run of the identity** — one transaction. |
| `fail_bluesky_refresh(ws, account, owner, expected_generation, definitive, message, now)` | Marks `reauthorization_required` only if the caller owns an unexpired lease, on the attempted generation, for a definitive rejection; then stops every active campaign of the identity (`stop_bluesky_campaigns_for_identity`). Transient failures only release the lease. |
| `release_bluesky_refresh_lease` | Crash/exception path. |
| `recover_bluesky_reauthorized_campaigns(ws?, account?, campaign?, now)` | `reauthorization_required` campaigns whose connection is `connected` → `active`; today's run `waiting_for_auth` (or the pre-coordinator `paused`/`failed` + recoverable code) → `running`; older `waiting_for_auth` runs → `completed` with the reason. Never touches an operator's `paused`. |
| `resume_bluesky_campaign_run_after_recovery` | Reproduced from its last definition; also leaves `waiting_for_auth`. |
| Grants | All new RPCs: `revoke all from public, anon, authenticated; grant execute to service_role`. Pinned by `grants-and-rls-real-session.pg.test.ts` (real login role) and `identity-session-coordinator.pg.test.ts`. |
| Tokens | No RPC returns a token column; the coordinator suite asserts the function result types contain no `token`. Encrypted blobs travel only as arguments. |
| Lock order | `platform_connections` (FOR UPDATE) → `growth_accounts` → `bluesky_follow_campaigns` (ORDER BY id, FOR UPDATE) → `bluesky_follow_campaign_runs`. Disjoint from the quota order (usage → run → reservation → ledger → action); asserted statically in the coordinator suite. |

The migration takes slot `…000002` because `20260917000001` is used by
unrelated in-flight work in the local checkout.

### Application

| Area | Change |
| --- | --- |
| `session.server.ts` | Is now the coordinator. A session carries `connectionStatus` and `tokenGeneration` read in the same query as the token. `refreshOnce()` = lease → (reload \| busy-wait \| refresh once → commit CAS \| guarded fail). Exported `refreshIdentitySession` for the publisher. New error code `provider_unavailable` for transient outcomes. A refreshed **or reloaded** session refuses a second refresh. |
| Follow + Unfollow workers | Same `refreshOnce()`; transient → new outcome `session_unavailable` → `yield` (run stays running, member re-opened, next delivery retries). Re-open code is the provider's own definite code (`ExpiredToken`). |
| Follow + Unfollow dispatchers | The identity decides first: anything but `connected` → campaign `reauthorization_required` (CAS from active), run `waiting_for_auth`, no provider call. Recovery = one RPC, no probe. `beforeFirstChunk` hook after the dispatch lease. `stop_campaign(reauthorization_required)` → run `waiting_for_auth`, never `paused`. |
| `dispatch-round.server.ts` | Recovery RPC before listing; lists `active` (+`rate_limited` for unfollow) only; `last_dispatched_at` written through the hook — after lease + session, before provider work. |
| Publishing orchestrator | Its private refresh (a third implementation) replaced by `refreshIdentitySession`. Its `markIdentityExpired` / `markIdentityMismatched` removed: only the coordinator moves identity state. Transient → `platform_api_error` (retryable), not a sign-out. |
| `/api/identity/:id/verify` ("Check account access") | Resolves through the service client so the coordinator RPCs are reachable; a refresh that succeeds here recovers the campaigns in the same transaction. Transient → 503 `provider_unavailable`, not "sign in again". |
| `/api/identity/:id/bluesky/connect` | After promoting the identity, calls the recovery RPC (the dispatcher repeats it on the next tick if this fails). |
| UI | `waiting_for_auth` rendered as "waiting for sign-in". |

### State model

Identity (authoritative): `platform_connections.connection_status` +
`token_generation`. Campaign and run state derive from it:

```
identity connected ──ExpiredToken──▶ coordinated refresh ──ok──▶ identity connected (gen+1); same attempt retried once
                                          │
                                          ├─ transient ──▶ identity unchanged; run running; member re-opened; next delivery retries
                                          └─ definitive ──▶ identity reauthorization_required; every active campaign → reauthorization_required;
                                                            every running run → waiting_for_auth; zero further provider calls
operator reconnects / any successful refresh ──▶ commit/recover: campaigns → active, today's run → running, counters kept
operator pause (campaign paused) ────────────▶ never recovered automatically; Resume moves waiting_for_auth → running
```

## 5. Evidence

All on the shipped migrations; only the network is a double.

| Scenario | File | Result |
| --- | --- | --- |
| C — stale failure after a newer generation | `incident-2026-09-15.pg.test.ts` | fails on `946019c` (identity `expired` over a valid pair); passes: connected, gen+1, 25/25, one refresh |
| D — successful refresh while campaign/run stopped | same | fails on `946019c` (campaign stays `reauthorization_required`); passes: same run resumed, refused member retried once, 12/12 |
| fairness stamp for zero work | same | fails on `946019c`; passes: stamp stays null over three ticks |
| A — one campaign, one refresh, one retry, one unit/intent/action | `identity-session-coordinator.pg.test.ts` | pass |
| E — revoked credential: one attempt, identity + all campaigns stop, zero further mutations, reconnect recovers all | same | pass |
| transient refresh error → nothing changes, next delivery refreshes | same | pass |
| crash after persistence → reload, zero provider refresh | same | pass |
| crash before provider refresh → lease lapses, one refresh | same + two-session | pass |
| crash after provider refresh, before persistence → consumed token refused once, wait, reconnect recovers | same + two-session | pass |
| operator pause during the wait is never undone | same | pass |
| follow + unfollow share one refresh; no cross-kind duplicate; no extra quota | same + two-session | pass |
| five campaigns on one identity, one refresh | same | pass |
| day boundary: yesterday's waiting run closed, today's fresh | same | pass |
| legacy state (connection connected, campaign stopped) healed on the next delivery without a probe | same | pass |
| grants: anon/authenticated cannot execute; service_role can; no token in any RPC result; lock order; idempotent migration; generation trigger; stale failure refused | same | pass |
| B — two real sessions, one identity, gated provider: one refresh, loser reloads, both complete, 30 units, no reauth | `identity-session-two-session.pg.test.ts` | pass |
| duplicate cron delivery (two concurrent fair rounds) | same | pass |
| reconnect during an active tick | same | pass |
| 100,000 members across days with a daily expiry | `incident-scale.pg.test.ts` (embedded) | see §6 |
| conservation | every scenario above asserts terminal + pending/retryable + leased + reconciling = frozen total | pass |

`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
`git diff --check` — results in §6.

## 6. Test-run and mutation-control results

Full run on the branch (`npm run typecheck`, `npm run lint`, `npm test`,
`npm run build`, `git diff --check`), in that order, one process:

| Step | Result |
| --- | --- |
| typecheck | exit 0 |
| lint | "No ESLint warnings or errors" |
| test | **296 files passed, 2 skipped; 5,337 tests passed, 8 skipped, 0 failed** (644 s; the 100k regression alone 230 s, one refresh per simulated day) |
| build | route table produced, no error |
| git diff --check | exit 0 |

**Mutation controls.** Each defect was introduced into the source, the
named suites run, the failure observed, and the file restored from git.
A control that stays green is a missing test, and one did: the first
version of the fairness scenario used a campaign already stopped for
authentication — which the fixed round no longer lists — so stamping
before the dispatcher could not be observed. The scenario was rewritten
around a campaign that IS listed but cannot be served (identity not
connected; another dispatcher holding today's run), and the control was
re-run. (A zsh word-splitting slip in the control runner also left the
m4 edits in place for the first pass of m5–m10; those five were re-run
on a clean tree and the figures below are from that re-run.)

| # | Defect introduced | Suites | Result |
| --- | --- | --- | --- |
| 1 | refresh locking removed (`acquire` never answers `busy`) | two-session | **4 of 6 fail** — B, duplicate delivery, lease lapse, crash-after-provider-refresh |
| 2 | token-generation CAS removed from acquire, commit and fail | incident + coordinator | **4 of 25 fail** — C, crash-after-persist, generation trigger, stale-failure guard |
| 3 | a stale worker may mark a newer session (generation and lease guards removed from `fail`) | coordinator + incident | **2 of 25 fail** — C, stale-failure guard |
| 4 | system auth stop maps to operator `paused` (dispatchers + stop RPC) | coordinator + 09-14 | **3 of 32 fail** — refresh-fails, E, crash-after-provider-refresh |
| 5 | only one campaign is recovered (`limit 1`) | coordinator | **1 of 22 fails** — E (three campaigns expected recovered, one was) |
| 6 | refreshed session discarded; stale credentials re-read without a generation check | 09-14 + coordinator | **7 of 32 fail** — A–G, quota-bound day, A, transient, lease lapse, follow+unfollow, five campaigns (every retry carried the stale token) |
| 7 | `last_dispatched_at` advanced before the dispatcher has proven anything | incident + fair round | **1 of 12 fails** — the rewritten fairness scenario (`expected 2026-09-15T13:55:00.001Z to be null`) |
| 8 | rejected-before-write sent to reconciliation (`rejectedBeforeWrite: false` on both auth outcomes) | coordinator + 09-14 | **6 of 32 fail** — refresh-fails, reconnect-resumes, E, transient, crash-after-provider-refresh, operator pause (members landed in reconciliation instead of a real retry) |
| 9 | the same-attempt retry consumes another quota unit | 09-14 + coordinator, then coordinator + two-session | **Two findings.** (a) Making the retry call `consume_bluesky_member_quota` a second time **stayed green (32 of 32)** — because the database refused it: the RPC answers `already_consumed` for an action whose ledger row already carries provider intent. That is a structural defence, not a test gap. (b) Counting the retry directly against the identity's usage ledger (`record_bluesky_identity_usage` +1 attempt on the retry path): **3 of 28 fail** — follow+unfollow (24 units expected), two-session B (30), two-session follow+unfollow (20) |
| 10 | the Unfollow worker refreshes on its own (independent lock) | two-session | **1 of 6 fails** — follow + unfollow meeting the same expiry (two provider refreshes observed) |

## 7. Deployment order

1. Apply `20260917000002_identity_session_coordinator.sql` (Supabase SQL
   editor or CLI). Old code + new schema is safe indefinitely: the new
   columns have defaults, the widened CHECK admits a value nothing
   writes, the RPCs are unused, and the trigger only maintains a
   counter.
2. Deploy the application commit. New code + old schema is **not**
   safe: `readEncryptedTokens` selects `token_generation` and the
   coordinator calls RPCs that would not exist; a refresh would fail
   as `provider_unavailable` (nothing marked, campaigns yield) until
   the migration lands. Do not deploy code first.
3. Post-apply check:
   ```sql
   select column_name from information_schema.columns
    where table_name = 'platform_connections'
      and column_name in ('token_generation','refresh_lease_owner','refresh_lease_expires_at');
   select proname from pg_proc where proname in
     ('acquire_bluesky_refresh_lease','commit_bluesky_refreshed_session','fail_bluesky_refresh',
      'release_bluesky_refresh_lease','recover_bluesky_reauthorized_campaigns','stop_bluesky_campaigns_for_identity');
   select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'bluesky_follow_campaign_runs_status_check'; -- contains waiting_for_auth
   ```

## 8. Production recovery plan

No data is deleted or rewritten. The only rows that move are the
campaign, its run and the identity mirror, through the same RPC the
dispatcher uses.

**Read-only preflight (run first, keep the output):**
```sql
-- The identity
select id, connection_status, health_status, token_generation, refresh_lease_owner,
       refresh_lease_expires_at, last_checked_at, metadata->>'last_message' as last_message
  from public.platform_connections
 where platform = 'bluesky' and account_id = (select id from public.growth_accounts where handle ilike '%webmasterid.bsky.social%');
select id, handle, connection_status from public.growth_accounts where handle ilike '%webmasterid.bsky.social%';

-- Campaigns on it that are stopped for authentication
select id, name, kind, status, last_error_code, next_run_at, last_dispatched_at
  from public.bluesky_follow_campaigns
 where operator_account_id = (select id from public.growth_accounts where handle ilike '%webmasterid.bsky.social%')
   and status = 'reauthorization_required';

-- Today's runs for them
select r.id, r.campaign_id, r.local_date, r.status, r.last_error_code, r.attempted_count, r.succeeded_count
  from public.bluesky_follow_campaign_runs r
  join public.bluesky_follow_campaigns c on c.id = r.campaign_id
 where c.status = 'reauthorization_required' and r.local_date = current_date;

-- Members owed a retry (must stay pending/retryable; never marked succeeded)
select a.id, a.subject_did, a.status, a.provider_error_code, a.provider_in_flight_at, m.status as member_status, m.next_attempt_at
  from public.bluesky_relationship_actions a
  join public.bluesky_follow_campaign_members m on m.id = a.campaign_member_id
 where a.campaign_id in (select id from public.bluesky_follow_campaigns where status = 'reauthorization_required')
   and a.status = 'pending' and a.provider_in_flight_at is null;
```

**Expected:** connection `connected`, campaign(s) `reauthorization_required`,
run `paused` with `reauthorization_required`, the ExpiredToken action
`pending` with no marker.

**Recovery:** after the migration and the deploy, the **next cron
delivery** recovers automatically (`recover_bluesky_reauthorized_campaigns`
runs before every round; the `paused` + `reauthorization_required` run
shape is explicitly recognised). No manual statement is required. If
the operator wants it sooner than five minutes, either press "Check
account access" on the identity (a successful refresh commits and
recovers in one transaction) or run, as the service role:
```sql
select * from public.recover_bluesky_reauthorized_campaigns(
  p_workspace_id := :workspace, p_account_id := :identity);
```
and re-run the preflight: campaign `active`, run `running` with the
same `attempted_count`, the pending action untouched (it is retried by
the worker under a new unit; its earlier unit stays spent).

If the identity's connection is **not** `connected` at that point, the
credential is genuinely gone: reconnect with the App Password on
Accounts; the connect route calls the same recovery.

## 9. Canary plan

1. Migration applied; code deployed with `BLUESKY_CAMPAIGNS_DISABLED=1`.
2. Preflight above. Then clear the kill switch during the execution
   window and watch two deliveries (10 minutes):
   - tick response `served` contains the campaign; `notes` say
     "identity is signed in again — recovered" once and never again;
   - `bluesky_follow_campaign_runs.status = running`, `attempted_count`
     rising, `last_error_code` null;
   - `platform_connections.token_generation` unchanged unless a refresh
     happened, in which case exactly +1 per refresh and
     `metadata.last_message = Session refreshed for …`;
   - `refresh_lease_owner` null between deliveries.
3. Forced-expiry check (optional, no mutation): press "Check account
   access" while a tick is running; expect either `session_valid` or a
   503 `provider_unavailable` — never a 409 while the stored pair is
   valid.
4. Watch for the transient path: a tick note ending "the next delivery
   retries" with the campaign still `active` and the run `running` is
   the designed behaviour for a provider blip.
5. Abort criteria: any `reauthorization_required` on the identity while
   `token_generation` moved in the same minute (would indicate a stale
   write — impossible by construction, so treat as a bug); any member
   with two `succeeded` createRecord attempts.

## 10. Limitations

- **No production access.** The winning peer at 13:01 (sibling
  campaign, publisher, duplicate delivery, button) is not established.
  The design makes every combination safe, and scenario B/C reproduce
  the two shapes on real backends.
- **Write-capability probe.** Bluesky offers no official non-mutating
  call that proves a session can write; `getSession` proves the
  session is valid and active. "Check account access" therefore proves
  the session, not the write scope; the first real request proves the
  rest. No record is ever created or deleted as a probe.
- **Busy wait.** A worker that finds the lease busy waits up to 12 s
  (250 ms polls) and then yields for this delivery. On a 55 s tick that
  bounds the cost of a slow peer refresh to one chunk.
- **Legacy `expired` status.** A connection left `expired` by pre-
  coordinator code (or by the publisher's old path) is treated as
  needing the operator: the dispatcher does not spend the stored
  refresh token on its own. "Check account access" still can, once,
  and a success recovers the campaigns.
- **`session_unreadable`** (cipher not configured) stops campaigns as
  `reauthorization_required` and, because the connection stays
  `connected`, is retried every delivery: a per-tick database write
  with no provider call, visible in the notes, until the key is fixed.
- **Runs from earlier days** left `paused` by the old code are not
  rewritten; only today's run is resumed.
