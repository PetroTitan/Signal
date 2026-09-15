# Incident 2026-09-15 (second) — the identity-session reload read a cached token

Identity `@webmasterid.bsky.social`, account `a9411a9b-dfd6-4d71-95f0-8874b2708cf8`,
platform connection `4ad3bd2a-950b-41ce-aaa2-0b736bd01de3`.

**Nothing in this document was executed against production.** Every
reproduction ran against the shipped migrations on a local PostgreSQL
with the REAL supabase-js service-role client, a `fetch` double that
translates PostgREST into SQL and reproduces Next's Data Cache
decision, and a provider double for Bluesky. No follow or unfollow was
performed. Production logs and the production database were not
reachable from this work; the timeline below is the operator's Vercel
evidence plus what the code demonstrably does.

Baseline `origin/main` = `c91bf90` (PR #198 and PR #199 merged).
Branch `fix/service-role-fetch-no-store`.

---

## 1. Reproduced facts

| Time (UTC) | Production evidence |
| --- | --- |
| 15:20:54 | The PR #198 coordinator refreshed the session: `connection_status = connected`, `health_status = healthy`, `token_generation = 1`. |
| 15:35:47 | `GET /api/campaigns/bluesky/tick`, Vercel request `7ggxw-1789486547108-3213ab3ab693`: `createRecord → 400 ExpiredToken`; `acquire_bluesky_refresh_lease` POST succeeds; **no** `com.atproto.server.refreshSession`; `createRecord → 400 ExpiredToken` again. The trace marks the `platform_connections` reads "Using cache". |
| after | Connection still connected / healthy / generation 1; growth account connected; campaigns active; `webmasterid-auto-300` run `waiting_for_auth`; `WebmasterID 1-3` run stopped for reauthorization; the pending action stores `ExpiredToken`. |

**Reproduced on unmodified `c91bf90`** by
`src/core/bluesky-campaigns/incident-2026-09-15-cached-reload.pg.test.ts`,
run in a detached worktree at that commit (log
`baseline-c91bf90-cached-reload.log`, verbatim in the PR): with the
service-role client built exactly as `createSupabaseServiceRoleClient`
built it and a Data Cache in the transport —

1. an earlier delivery (15:05) stored the identity's reads at
   generation N;
2. another invocation refreshed through the coordinator (N+1, `jwt-NEW`);
3. the 15:35 delivery: `createRecord(jwt-OLD)` → 400; the lease POST
   ran fresh and answered `reload` (stored N+1 ≠ observed N); the reload
   GET was **served from cache** (generation N, `jwt-OLD`);
   `createRecord(jwt-OLD)` → 400 again; **zero** `refreshSession`;
   the campaign was stopped `reauthorization_required` with the run
   `waiting_for_auth` while the identity read connected at N+1;
4. the 15:40 delivery: the recovery RPC saw `connected`, reactivated the
   campaign, the cached reads failed it again — and the campaign-stop
   PATCH (which chains `.select()` and answers 200) was itself replayed
   from cache, so the campaign stayed `active` with its run
   `waiting_for_auth`: **production's snapshot, exactly**. A second
   member paid a unit for a request that could not succeed.

### The third finding: the sweep could not see `active` + `waiting_for_auth`

After the operator reconnected (`Signed in — Signal can act as this
account`), the scheduled slot left campaign `cdbb2b76…` **`active`**
with today's run **`waiting_for_auth`** (20 attempted, 18 succeeded,
last success 15:35:55Z), and the identity's other active campaign kept
an authentication-stopped run too.

`recover_bluesky_reauthorized_campaigns` — the sweep the fair round
runs before listing — selected `f.status = 'reauthorization_required'`
only. That valid combination was excluded before the run was inspected,
so the sweep could never repair it. (The dispatcher's own in-run resume
would have continued it — but only with a working session, which the
cached reads above denied.)

**Reproduced on unmodified `c91bf90`** by
`incident-2026-09-15-active-waiting.pg.test.ts` in the detached
worktree (log `baseline-c91bf90-active-waiting.log`): with a connected
connection holding encrypted tokens, an active campaign, today's run
`waiting_for_auth` with preserved counters and queued members, the same
entry point `dispatch-round.server.ts` calls returned **zero recovered
campaigns**, the run stayed `waiting_for_auth`, and no provider call
was made (the sweep has no provider access at all). The health function
did not exist.

## 2. Root cause

`createSupabaseServiceRoleClient()` built supabase-js with no `fetch`
option, so the client resolved the **global** fetch — inside a Next.js
route handler, Next's patched fetch — and passed no cache directive.
Next 14.2's decision (`next/dist/server/lib/patch-fetch.js`):

- `cache` undefined and `fetchCache` undefined → the request is
  cacheable ("auto cache", `revalidate = false`) **unless**
  `autoNoCache` fires;
- `autoNoCache = (Authorization or Cookie header || non-GET method) &&
  store.revalidate === 0`;
- the route store's `revalidate` is set to 0 **only for routes with
  non-GET methods** (`app-route/module.js`); `export const dynamic =
  "force-dynamic"` only sets `forceDynamic = true`.

The tick route exports only `GET`, so `store.revalidate` was never 0,
the `Authorization` header supabase-js injects did not help, and every
request — GET reads, and 200-answering PATCH/POST — was keyed
(url + method + headers + body) and stored in the persistent Data Cache
across invocations. RPC POSTs escaped only because their bodies carried
unique owners and timestamps.

Two consequences in the coordinator then turned a stale read into a
contradiction:

- `reloadLatest()` trusted the read after a `reload` verdict; it had no
  way to know it was handed the row it already held.
- The reloaded session carries `refreshAllowed = false`; its second
  rejection returned `session_expired` ("sign in again") although
  `fail_bluesky_refresh` had never run and the identity was not marked.
  The worker mapped that to `authentication_expired` →
  `stop_campaign(reauthorization_required)`; the dispatcher stopped the
  run; and the recovery RPC, which only asked "is the connection
  `connected`?", reactivated the campaign every delivery.

## 3. What changed

### Transport (the cause)

`src/lib/supabase/service-role.ts` — one audited wrapper, `noStoreFetch`:
`fetch(input, { ...init, cache: "no-store" })`. It preserves method,
headers, body, signal and every other RequestInit field, resolves the
global fetch at call time, and is passed as `global.fetch` to
`createClient`. Nothing else constructs a service-role client
(`service-client-contract.test.ts` pins that, and pins every
coordinator caller — the campaign tick, "Check account access", the
App-Password connect route, the publishing scheduler, the manual
campaign commands — to this construction).

### Coordinator (defence in depth)

`src/core/bluesky-relationships/session.server.ts`:
- **A reload must observe a newer generation.** After a `reload`
  verdict the fresh read's generation must exceed the one the worker
  held; otherwise the read was not fresh (`reload:stale_read`), the
  worker yields for this delivery, and nothing is marked or retried.
- **A session that already spent its renewal answers
  `refresh_exhausted`**, never `session_expired`. The identity was not
  decided on; the worker yields.
- **A definitive rejection whose lease had lapsed** (`fail` refused
  with `lease_lost`) yields too — the identity was not marked, so the
  worker must not say it was.
- **Structured, token-free diagnostics** (`CoordinatorEvent`): one line
  per decision on `console.info` (`[bluesky-session] {…}`) or an injected
  sink — caller (`source`), lease verdict, observed and stored
  generation, refresh outcome, commit/fail verdict and reason, counts.
  Never a JWT, blob, key or header; asserted by test.

### Workers

Both workers: a **second refreshable rejection after a renewal**
(refresh or reload) is `session_unavailable` → `yield`: member re-opened
(`ExpiredToken`, no marker, owed a retry), run stays `running`, campaign
stays `active`, no second unit or intent. `authentication_expired` is
now reserved for a NON-refreshable rejection (AccountTakedown, 403) or a
coordinator verdict that the identity genuinely needs the operator.

### Dispatchers

Both dispatchers: an authentication stop is **identity-wide and
generation-stamped** through `stop_bluesky_campaigns_for_identity` —
never a per-campaign `reauthorization_required` written on the
dispatcher's own authority. A cipher fault (`session_unreadable`) yields
instead of stopping. Operator pauses are untouched (the RPC selects
`active` only).

### Migration — `20260917000004_campaign_auth_stop_generation.sql` (forward-only, idempotent)

| Item | Detail |
| --- | --- |
| `bluesky_follow_campaigns.auth_stopped_at_generation bigint` | The identity's `token_generation` when the campaign was stopped for authentication. |
| `stop_bluesky_campaigns_for_identity` | Locks the identity row first, reads its generation, stamps it on every stopped campaign. |
| `bluesky_local_date_safe(timestamptz, text)` | A campaign's local date; falls back to UTC for an unparseable zone so one bad row cannot fail the sweep. |
| `recover_bluesky_reauthorized_campaigns(ws?, account?, campaign?, now, after_campaign_id?, limit)` | **Dropped and recreated** (two new defaulted parameters; the old signature would make named-argument calls ambiguous). Repairs **A** `reauthorization_required` (generation moved past the stamp; null = legacy), **B** `active` + today's run `waiting_for_auth`, **C** the legacy `paused`/`failed` + recoverable-code run shapes. Eligibility: same workspace/account/platform connection, `connected`, encrypted access token present, campaign `active` or `reauthorization_required` only (never `paused`, `cancelled`, `completed`, …), run stop an explicitly recoverable system state. One transaction per campaign: campaigns (ORDER BY id, FOR UPDATE) → runs; eligibility **re-verified under the lock** so two simultaneous sweeps report a campaign once. Campaign → `active`; only recoverable error fields cleared; the same current-day run → `running` (id, quota, counters, reservations, attempts, queue untouched); prior-day `waiting_for_auth` runs → `completed` with an explicit reason; `next_run_at = now` (the dispatcher's start-date and window checks still apply). Keyset-paged, bounded (`limit ≤ 500`, no OFFSET); returns `campaign_id, kind, run_id, run_resumed, previous_status, next_run_at, identity_id, token_generation`. |
| `bluesky_recovery_health()` | The rows that must normally be empty: connected identity + `active`/`reauthorization_required` campaign + today's run stopped by the system for authentication. Alert if non-empty for two cron intervals. |
| Grants | Every function: `revoke all from public, anon, authenticated; grant execute to service_role`. Asserted on real PostgreSQL (real login role) and PGlite. No token content returned. |

### Sweep, connect route, page

- `dispatch-round.server.ts` runs the sweep before listing every round,
  walking pages by campaign id (200 per page, at most 5 pages per
  delivery; the next delivery continues), and emits one
  `[bluesky-recovery]` line per repaired campaign
  (`identity_id, campaign_id, run_id, token_generation, previous_status,
  new_status, recovery_verdict, next_run_at`) plus a summary
  (`recovered_campaigns, resumed_runs`).
- `/api/identity/:id/bluesky/connect` calls the sweep for the identity
  after the connection is persisted and returns `recovered_campaigns`,
  `resumed_runs`, `recovery_pending` (and a message). A reconnect is
  durable even when recovery fails; then `recovery_pending: true`, and
  every scheduler delivery repeats the same idempotent sweep.
- The campaign page says "Recovery pending: … the next scheduler
  delivery resumes today's run" when the identity is already signed in,
  and "Sign in again" only when it is not.

**Is a migration required?** The transport fix and the coordinator
hardening need none. The migration closes the recovery-loop hole
independently: without it, any future per-campaign contradiction would
again be reactivated every delivery by a `connected` flag that never
changed. The pair is what the brief asks for; ship both.

## 4. Evidence

RESULTS_PLACEHOLDER

## 5. Deployment and supervised recovery order

1. **Apply the migration first** (`…000004`). Old code + new schema is
   safe: the column defaults to null; the replaced RPCs are
   call-compatible (same signatures) and, with no stamps written, behave
   as before.
2. **Deploy the application.** New code + old schema: the dispatcher's
   stop RPC and the recovery RPC still exist (from `…000002`) with their
   old bodies — safe but without the generation guard; the transport
   fix and the yield fixes work regardless. Do not run in that state
   for long.
3. **Never re-run an older migration on its own.** Re-applying
   `20260917000002` after `…000004` reverts `stop_bluesky_campaigns_for_identity`
   to the unstamped body (found by the test suite doing exactly that).
   If a replay is needed, replay the whole tail in order.
4. **Duplicate version prefix on main.** `20260917000002_identity_session_coordinator.sql`
   and `20260917000002_linkedin_import_chunk.sql` share a version. The
   SQL-editor path is unaffected; a CLI `db push` may refuse duplicate
   versions. Not changed here (both are applied); flagged.
5. **Production recovery.** Read-only preflight (as the service role):
   ```sql
   select connection_status, health_status, token_generation, refresh_lease_owner, refresh_lease_expires_at,
          metadata->>'last_message' as last_message
     from public.platform_connections where id = '4ad3bd2a-950b-41ce-aaa2-0b736bd01de3';
   select id, name, status, last_error_code, auth_stopped_at_generation, next_run_at, last_dispatched_at
     from public.bluesky_follow_campaigns
    where operator_account_id = 'a9411a9b-dfd6-4d71-95f0-8874b2708cf8' and status <> 'cancelled';
   select r.campaign_id, r.local_date, r.status, r.last_error_code, r.attempted_count, r.succeeded_count
     from public.bluesky_follow_campaign_runs r
     join public.bluesky_follow_campaigns c on c.id = r.campaign_id
    where c.operator_account_id = 'a9411a9b-dfd6-4d71-95f0-8874b2708cf8' and r.local_date = current_date;
   select a.id, a.subject_did, a.status, a.provider_error_code, a.provider_in_flight_at, m.status as member_status, m.next_attempt_at
     from public.bluesky_relationship_actions a
     join public.bluesky_follow_campaign_members m on m.id = a.campaign_member_id
    where a.operator_account_id = 'a9411a9b-dfd6-4d71-95f0-8874b2708cf8'
      and a.status = 'pending' and a.provider_in_flight_at is null;
   ```
   Expected today: connection connected / generation ≥ 1; campaigns
   `active` (or `reauthorization_required`); today's runs
   `waiting_for_auth`; pending `ExpiredToken` actions with no marker.
   **No manual statement is required.** On the first delivery after
   the deploy every read is fresh: the stored generation-1 (or later)
   token is used; if it has since expired, the coordinator refreshes
   once (generation +1) and continues; `waiting_for_auth` runs of
   active campaigns resume through the in-dispatcher recovery
   (`resume_bluesky_campaign_run_after_recovery`, recoverable code).
   The pending actions are retried by the worker under new units; their
   earlier units stay spent; no action is marked succeeded by hand.
6. **Supervise** two deliveries: tick `served` lists the campaigns;
   `[bluesky-session]` lines show `lease:acquired → refresh:refreshed →
   commit:committed` at most once per identity per expiry and never
   `reload:stale_read`; runs `running` with `attempted_count` rising;
   `refresh_lease_owner` null between deliveries; no
   `auth_stopped_at_generation` set while `connection_status` is
   `connected`.
7. **Abort criteria:** any `reload:stale_read` event (a cache is still in
   the path); any campaign `reauthorization_required` with a stamp equal
   to the current generation while the run count rises elsewhere; any
   member with two `succeeded` `createRecord` attempts.

## 6. Not verified in production

- The Vercel trace's "Using cache" markers were not read by this work;
  the mechanism is established from Next 14.2.20's source and reproduced
  with a faithful double, not from the production cache itself.
- Whether production's cached responses included the 200-answering
  PATCH (the double shows it would, and the snapshot matches) cannot be
  confirmed without the trace.
- Bluesky's behaviour on a freshly minted token being rejected again is
  not modelled beyond "yield and refresh next delivery".
- The publishing scheduler's own reads run in a GET route handler too
  (`/api/scheduler/tick`); they now go through the same client and the
  same wrapper, but no publishing-path incident was reproduced here.
