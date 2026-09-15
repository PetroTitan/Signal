# Follow / Unfollow campaigns — production runbook (2026-09-16)

The single operational document for running Bluesky follow and unfollow
campaigns in production after the 2026-09-15 supervised canary. It
consolidates and supersedes the "safe activation" and "canary" sections
of `campaigns-runbook.md` and `unfollow-campaigns-runbook.md`, which
remain the reference for architecture and invariants.

Everything below is written to be executed **one step at a time, by a
person, watching the numbers**. Nothing in it is a script.

## 0. What the 2026-09-15 canary established, and what this change fixes

| Observed | Cause (in code at `45d14d6`) | Fix in this change |
| --- | --- | --- |
| Unfollow confirmation asked for `@handle` but only enabled for `@@handle` | the dialog stripped one `@` from the typed value and none from the stored handle (`growth_accounts.handle` keeps the operator's `@`) | one normaliser on both sides — `confirmationHandleMatches` |
| Confirmation showed 09:00–20:00 UTC for a campaign persisted with 00:00–01:00 UTC | the dialog was built from the wizard's React state, not the row | facts loaded from the row and frozen queue; a fingerprint is checked at activation |
| `/relationships/unfollow/<id>` "was a wizard with defaults" | the "View campaign" links pointed unfollow campaigns at the follow page, which drew its create form beneath them | kind-aware campaigns page; unfollow ids redirect to the unfollow dashboard, which is now complete |
| Unfollow campaign listed under "Follow campaigns" | one list, no kind | "Campaigns" with kind on every entry and a filter per kind |
| Relationships card showed one campaign while two were active | the summary picked the single most live campaign in the workspace | every live campaign of both kinds for the selected identity, with the shared ceiling |
| One 20-member chunk per delivery; nothing guaranteed the next delivery served anyone else | follow first with the whole budget; chunk after chunk per campaign; no persisted order | bounded round-robin with a persisted `last_dispatched_at`; conservative deadline |
| Dry-run rows read as "skipped" | correct status, misleading label | labelled "Simulated (dry run)", counted apart |
| 3 actions needing reconciliation with no workflow | no read-only path | "Reconcile now" on both campaign kinds and for manual actions — reads only |

## 1. Pre-flight queries (run before any change, and again before any canary)

All as the service role or a superuser in the SQL editor. Replace the
identity id.

```sql
-- 1a. Nothing outstanding for the identity: leases, reservations, intents, unresolved actions.
select
  (select count(*) from public.bluesky_follow_campaign_members m
     join public.bluesky_follow_campaigns c on c.id = m.campaign_id
    where c.operator_account_id = :identity and m.lease_expires_at > now())            as open_leases,
  (select count(*) from public.bluesky_campaign_quota_reservations r
    where r.operator_account_id = :identity and r.status in ('open','held'))           as open_reservations,
  (select count(*) from public.bluesky_campaign_attempt_ledger l
    where l.operator_account_id = :identity and l.provider_intent_at is not null
      and l.counted_at is null)                                                        as uncounted_intents,
  (select count(*) from public.bluesky_relationship_actions a
    where a.operator_account_id = :identity
      and a.status in ('pending','running','reconciliation_required'))                 as unresolved_actions;

-- 1b. Today's spend against the shared 1,000-action ceiling.
select usage_date, follows_created, unfollows_deleted, attempts_made, delete_attempts_made
  from public.bluesky_identity_daily_usage
 where operator_account_id = :identity and usage_date = current_date;

-- 1c. Every campaign on the identity, with its kind, status and dispatch order.
select id, kind, name, status, requested_daily_quota, timezone,
       execution_window_start_minute, execution_window_end_minute,
       next_run_at, last_dispatched_at, rate_limited_until, last_error_code
  from public.bluesky_follow_campaigns
 where operator_account_id = :identity
 order by last_dispatched_at nulls first, next_run_at;

-- 1d. Conservation for one campaign: every member in exactly one category.
select * from public.bluesky_campaign_conservation(:workspace, :campaign);
select public.bluesky_campaign_may_complete(:workspace, :campaign);

-- 1e. Kill switches.
select * from public.bluesky_campaign_kill_switches where engaged;
```

Expected before a canary: 1a all zero; 1e empty (or exactly the switch
you engaged on purpose).

## 2. Migration and code order

This change ships **one** migration, `20260916000001_campaign_dispatch_fairness.sql`:
`alter table … add column if not exists last_dispatched_at timestamptz`.
Forward-only, idempotent (applied twice in the real-PostgreSQL suite),
no RPC body touched, no grant changed (the pinned executable set is
asserted by `src/test/pg/grants-and-rls-real-session.pg.test.ts`).

**Order: migration first, then code.**

- Old code + new migration: the column is unused; nothing reads it.
  Safe indefinitely.
- New code + old schema: `touchCampaignDispatched` would fail on the
  missing column. The dispatcher **catches that and continues** (a
  note is added to the tick result; fairness order is lost for that
  delivery, nothing else). So a code-first deploy degrades to the
  previous ordering rather than breaking — but do not rely on it.

Post-apply check:

```sql
select column_name, data_type, is_nullable from information_schema.columns
 where table_name = 'bluesky_follow_campaigns' and column_name = 'last_dispatched_at';
```

No other schema change. The previous change's migration
(`20260915000001_campaign_run_recovery.sql`) must already be applied —
it is, per the canary evidence.

### 2a. The identity-session coordinator (added 2026-09-15)

One more migration, `20260917000002_identity_session_coordinator.sql`
(see `incident-2026-09-15-identity-session.md` §7): three columns on
`platform_connections` (defaults), one trigger, one widened run-status
CHECK, six service_role-only RPCs, one partial index.

**Order: migration first, then code — and this time it matters.** Old
code with the new schema is safe indefinitely. New code with the old
schema cannot refresh a session at all (the RPCs do not exist): every
expiry would yield until the migration lands. Nothing would be marked
and nothing lost, but nothing would progress either.

Post-apply check: the three columns exist, the six functions exist,
`bluesky_follow_campaign_runs_status_check` contains `waiting_for_auth`.
Production's stopped campaign recovers on the first delivery after the
deploy (`recover_bluesky_reauthorized_campaigns` recognises the
`paused` + `reauthorization_required` shape).

## 3. Rollback and kill switch

Three independent stops, from least to most blast radius:

1. **Pause one campaign** — the Pause control on its page. Stops future
   work for that campaign only. Never re-follows or re-unfollows.
2. **Stop one identity** — "Stop this identity" on any campaign page,
   or:
   ```sql
   insert into public.bluesky_campaign_kill_switches
     (workspace_id, operator_account_id, engaged, reason, engaged_at)
   values (:workspace, :identity, true, 'operator stop', now());
   ```
   Both dispatchers consult it before any provider call, and **even a
   read-only reconcile stops** (proven in `reconcile-now.pg.test.ts`).
3. **Stop everything** — set `BLUESKY_CAMPAIGNS_DISABLED=1` on the
   deployment and redeploy. The tick returns immediately without
   touching the database.

Code rollback: redeploy the previous commit. The new column is inert
for old code. `last_dispatched_at` values already written are hints
and need no cleanup.

## 4. Deadline and throughput

The tick plans against `BLUESKY_TICK_BUDGET_MS` (default **55,000 ms**,
maximum 240,000 ms), not against `maxDuration`. It stops CLAIMING new
work once less than one chunk's cost (30 s: 20 members × 1,000 ms
spacing + 500 ms latency) plus a 5 s settle margin remains. A claimed
chunk is always settled or released by its own code.

Consequences the operator must expect:

- Under the default, **about one 20-member chunk per delivery**, one
  delivery every five minutes: ~240 actions per hour across all the
  identity's campaigns, in rotation.
- **300/day does not mean 300 in one request.** A 300/day campaign
  sharing an identity with one other campaign will take about 2½ hours
  of deliveries to spend its day.
- On a runtime known to allow 300 s (Vercel Pro — verify in the
  project's Functions settings, it was not verifiable from the
  repository), set `BLUESKY_TICK_BUDGET_MS=240000` to allow ~7 chunks a
  delivery. Do not set it above what the platform enforces: a killed
  invocation loses nothing, but it wastes a lease.

Fairness: each delivery orders due campaigns by `last_dispatched_at`
(never served first), gives each at most one chunk per round, and runs
another round only if time remains. Follow's priority over unfollow is
a **quota** rule: an unfollow campaign stands aside only when the
identity's remaining budget today is no more than what the due follow
campaigns still need.

## 5. Supervised Follow dry run

1. Create the follow campaign with **dry run on**, quota 100, a window
   that includes now.
2. Run 1a–1e. Note `follows_created` and `attempts_made`.
3. Trigger one tick (or wait for the cron). Watch the campaign page.
4. Verify:
   ```sql
   select status, last_error_code, count(*) from public.bluesky_follow_campaign_members
    where campaign_id = :campaign group by 1,2;
   -- expect: skipped/dry_run rows only; no succeeded
   ```
   1b unchanged; 1a all zero; the page labels every row "Simulated
   (dry run)".
5. Cancel the dry-run campaign.

## 6. One Follow canary (real)

1. New follow campaign, dry run **off**, quota 100, one member in the
   queue (import a one-profile list).
2. Run 1a–1c. Confirm the identity's session works (Accounts shows
   "Signed in"; `getSession` succeeds).
3. One tick. Verify **exactly one** `createRecord`:
   ```sql
   select a.status, a.follow_uri, a.provider_error_code, a.provider_intent_at, a.finished_at
     from public.bluesky_relationship_actions a where a.campaign_id = :campaign;
   select * from public.bluesky_campaign_conservation(:workspace, :campaign);
   ```
   Expect one action `succeeded` with a `follow_uri`, conservation:
   `succeeded = 1`, everything outstanding = 0; 1b `follows_created`
   +1, `attempts_made` +1.
4. Check the run row: `status = completed` (queue exhausted) and the
   campaign `completed`.

## 7. Unfollow dry run

1. Unfollow campaign, source "everyone this account follows", **dry run
   on**, quota 100.
2. Open the confirmation. It must show the persisted time zone and
   window (check against 1c) and ask for the handle **with one `@`**;
   typing exactly what it shows enables the button.
3. Start. One tick. Verify `deleteRecord` count is zero:
   ```sql
   select status, last_error_code, count(*) from public.bluesky_follow_campaign_members
    where campaign_id = :campaign group by 1,2;   -- skipped/dry_run only
   ```
   1b `unfollows_deleted` and `delete_attempts_made` unchanged.
4. Pause or cancel the dry-run campaign.

## 8. One real Unfollow canary

1. Unfollow campaign from an imported one-profile list you are willing
   to stop following, dry run **off**, quota 100.
2. Confirmation: same checks as §7 step 2.
3. One tick. Verify exactly one `deleteRecord` and the candidate's
   state:
   ```sql
   select a.status, a.follow_uri, a.follow_rkey, a.reconciled_state
     from public.bluesky_relationship_actions a where a.campaign_id = :campaign;
   select subject_did, relationship_state, follow_uri, follow_rkey
     from public.bluesky_candidates where operator_account_id = :identity and subject_did = :did;
   ```
   Expect the action `succeeded` with the deleted record's uri/rkey,
   the candidate `not_following` with uri/rkey cleared; 1b
   `unfollows_deleted` +1.

## 9. Reconciliation verification

1. On the Relationships page, History tab: press **Reconcile now**.
   The panel lists each action read: profile, attempted operation,
   what Bluesky reports, when it was read, and the resulting status.
2. Verify **no provider mutation** happened: 1b unchanged.
3. For a campaign, the same control is on its page; it runs the
   dispatcher with zero reserved units. Verify:
   ```sql
   select status, reconciled_state, reconciled_at, reconciliation_note
     from public.bluesky_relationship_actions where campaign_id = :campaign
      and reconciled_at > now() - interval '10 minutes';
   ```
   Actions Bluesky can settle become `succeeded`; the rest stay
   `reconciliation_required` with a fresh note and time and a member
   backoff (`next_attempt_at` in the future, `reconcile_count` up).
4. A campaign is never marked `completed` while any action is
   unresolved: `bluesky_campaign_may_complete` returns false.

## 10. Exact queries — leases, reservations, ledger, quota, unresolved

```sql
-- Leases held right now (should be empty between ticks)
select m.campaign_id, m.id, m.claimed_by, m.lease_expires_at
  from public.bluesky_follow_campaign_members m
 where m.lease_expires_at > now();

-- Reservations open or held
select id, campaign_id, run_id, reserved_count, status, claimed_by, expires_at
  from public.bluesky_campaign_quota_reservations where status in ('open','held');

-- Intents sent but not yet folded into the day's books
select l.*
  from public.bluesky_campaign_attempt_ledger l
 where l.provider_intent_at is not null and l.counted_at is null;

-- Quota: requested vs effective vs spent, per run today
select c.name, c.kind, r.local_date, r.status, r.requested_daily_quota, r.effective_daily_quota,
       r.effective_quota_reason, r.attempted_count, r.succeeded_count, r.failed_count,
       r.already_following_count, r.already_absent_count, r.reconciliation_required_count
  from public.bluesky_follow_campaign_runs r join public.bluesky_follow_campaigns c on c.id = r.campaign_id
 where r.local_date = current_date;

-- Unresolved actions, with what the last read saw
select a.campaign_id, a.subject_did, a.action_type, a.status, a.provider_error_code,
       a.reconciled_state, a.reconciled_at, a.reconciliation_note
  from public.bluesky_relationship_actions a
 where a.status in ('pending','running','reconciliation_required')
 order by a.requested_at;

-- Dispatch order the next delivery will use
select id, kind, name, status, last_dispatched_at, next_run_at
  from public.bluesky_follow_campaigns
 where status in ('active','rate_limited','reauthorization_required')
 order by last_dispatched_at nulls first, kind, next_run_at;
```

## 11. Not done, by design

- No migration was applied, no campaign activated, no follow or
  unfollow performed, nothing merged or deployed.
- The Vercel plan and function ceiling for this project could not be
  read from the repository or the connector; the deadline default
  assumes 60 s. Confirm the plan and set `BLUESKY_TICK_BUDGET_MS`
  accordingly before relying on higher throughput.
