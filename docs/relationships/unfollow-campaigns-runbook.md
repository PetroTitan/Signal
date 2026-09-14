# Bulk Unfollow Campaigns — production runbook

Applies to the Bluesky unfollow campaign subsystem introduced by
`20260914000001_bluesky_unfollow_campaigns.sql`.

**Nothing in this document has been executed against production.** No
migration was applied, no deploy was made, no campaign was activated and
no follow record was deleted. The canary in §9 is a plan, not a record.

---

## 1. Architecture and invariants

### What it is

An operator-approved, frozen queue of profiles to unfollow, processed
autonomously by the existing authenticated cron until the queue is
terminal. One explicit activation; no daily interaction.

### What it reuses, unchanged

The hard parts are the Follow subsystem's, and they are called as they
are — not copied:

| Primitive | Function |
| --- | --- |
| Atomic reserve + claim | `reserve_bluesky_campaign_quota` |
| Provider-intent consumption | `consume_bluesky_member_quota` |
| Settlement | `apply_bluesky_run_outcome` |
| Crash sweep | `sweep_bluesky_quota_reservations` |
| Owned release | `release_bluesky_campaign_members_owned` |
| Dispatch lease | `acquire/release_bluesky_run_dispatch_lease` |
| Daily run idempotency | `ensure_bluesky_campaign_run` |

### The invariants

1. **One unresolved relationship intention per (workspace, identity,
   subject).** `bluesky_relationship_actions_one_intent`. A Follow and
   an Unfollow can never be in flight for the same person at once.
2. **A campaign's `kind` is immutable**, and each claim RPC RAISES on
   the wrong kind. The Follow dispatcher cannot act on an unfollow
   queue even if its query filter were wrong.
3. **Quota is spent at provider intent**, in the same transaction that
   stamps `provider_intent_at` (never cleared) and
   `provider_in_flight_at` (cleared on every terminal path), one
   statement before the request.
4. **A crash before intent is safe to retry; a crash after intent is
   reconciliation-only.** There is no state in between.
5. **An rkey is never derived.** Every delete target is a provider
   reading, re-resolved immediately before intent; the fresh one wins.
6. **Protection is re-checked inside the claim transaction**, so an
   allowlist entry added today protects a queue frozen last week.
7. **The queue is frozen** once the campaign leaves `draft` /
   `building_queue`. `import_bluesky_unfollow_member_chunk` raises
   otherwise.
8. **Counters are folded from the ledger**, never from worker memory.
9. **Follow and Unfollow share ONE per-identity daily ceiling**, through
   `bluesky_identity_daily_usage.attempts_made`, incremented by the
   shared consume RPC for both kinds.

### Lock order — everywhere in this subsystem

```
identity usage → run → reservation → ledger → action
```

Any function taking them in another order deadlocks when two campaigns
share an identity.

### State machines

Campaign: `draft → building_queue → ready → active`, with `paused`,
`rate_limited`, `reauthorization_required`, `completed`, `cancelled`,
`failed`. Only an operator leaves `paused`.

Member: `queued → claimed → provider_in_flight →` one of `succeeded`,
`already_not_following`, `retryable`, `failed_structural`; plus
`protected` and `cancelled`.

---

## 2. Migration and deployment order

1. Merge the PR. **Do not deploy yet.**
2. **Pre-flight the conflict index.** The migration REFUSES to apply if
   any `(workspace, identity, subject)` already holds more than one
   in-flight action. Check first:

   ```sql
   select workspace_id, operator_account_id, subject_did, count(*)
     from public.bluesky_relationship_actions
    where status in ('pending','running')
    group by 1,2,3
   having count(*) > 1;
   ```

   Expect zero rows. If not, each pair is a stuck action needing a
   human decision — resolve it (§7) before applying.
3. Apply `20260914000001_bluesky_unfollow_campaigns.sql`. Additive and
   idempotent; existing campaigns default to `kind='follow'`.
4. **Verify before deploying the app:**

   ```sql
   -- the discriminator, defaulted
   select kind, count(*) from public.bluesky_follow_campaigns group by 1;

   -- the conflict guard, and that it is TOTAL
   select indexdef from pg_indexes
    where indexname = 'bluesky_relationship_actions_one_intent';
   -- must NOT mention action_type

   -- privileges: true, false, false, false
   select has_function_privilege('service_role',
            'public.claim_bluesky_unfollow_action(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,uuid)','EXECUTE'),
          has_function_privilege('authenticated', '…same…','EXECUTE'),
          has_function_privilege('anon',          '…same…','EXECUTE'),
          has_function_privilege('public',        '…same…','EXECUTE');
   ```
5. Deploy the application.
6. **`vercel.json` is unchanged.** `/api/campaigns/bluesky/tick` runs
   both dispatchers, Follow first (§3).
7. Canary (§9), operator-supervised. Never automated.

### Rollback

**Roll forward.** Do not edit an applied migration. To stop the feature
immediately, engage a kill switch (§8) — it needs no deploy.

---

## 3. Scheduler configuration

One cron, unchanged: `*/5 * * * *` → `/api/campaigns/bluesky/tick`,
`maxDuration = 300`.

Inside one invocation: **Follow runs first**, then Unfollow with
whatever wall clock remains (and is skipped entirely if under 20s are
left). The order is a decision: if the identity's budget runs out, the
work that does not happen is the irreversible deletion, not the
creation.

On Hobby the platform clamps `maxDuration` to 60s. The system stays
correct — fewer chunks per tick, the next delivery continues — and the
unfollow pass will usually be skipped. Pro is assumed.

---

## 4. Environment variables

Names only. No values appear in this repository or this document.

| Variable | Purpose |
| --- | --- |
| `CRON_SECRET` | What Vercel Cron sends; authenticates the tick. |
| `SCHEDULER_TICK_TOKEN` | Manual invocation alternative. |
| `SUPABASE_SERVICE_ROLE_KEY` | The worker's database identity. Never reaches a client bundle. |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The app's own client. |
| `BLUESKY_CAMPAIGNS_DISABLED` | Deploy-level kill switch for BOTH kinds. Checked before the database. |

The tick returns **503 when unconfigured** and **401 on mismatch**. It
is never a silent no-op.

---

## 5. Safe activation

1. **Dry run first.** The checkbox is on by default in the wizard.
2. Build the queue. The wizard says "still building" until the source is
   exhausted; activation is refused before then.
3. On the confirmation screen, check: acting identity, source, exact
   count (or an honest "still counting"), protected count, remaining
   eligible, requested vs effective quota, timezone and window,
   estimated days (labelled an estimate).
4. Type the handle and the phrase `start automatic unfollowing`. The
   server compares the typed handle to the handle the **session
   actually resolves to**, not to what the form said.
5. Press **Start automatic unfollowing**.

Activation is refused when: the queue is incomplete or failed; the
campaign is not `ready`/`paused`; the account is disconnected; the
session does not resolve; the typed handle does not match; the queue is
empty; the role lacks `connect_platforms`.

---

## 6. Dry run

A dry run performs every step EXCEPT the provider call — and
short-circuits **before** `consume_bluesky_member_quota`, so it spends
no unit, stamps no intent and creates no ledger obligation. Members are
recorded `skipped`, never `succeeded`.

Verify a dry run touched nothing:

```sql
select count(*) from public.bluesky_campaign_attempt_ledger l
  join public.bluesky_follow_campaign_members m on m.id = l.member_id
 where m.campaign_id = :campaign and l.provider_intent_at is not null;
-- expect 0
```

---

## 7. Operating it

### Pause / resume / cancel

| Control | Effect |
| --- | --- |
| **Pause now** | Stops new claims. In-flight members finish or lapse. Never auto-resumed. |
| **Resume** | Re-checks the session, then continues on schedule. |
| **Cancel future work** | Withdraws every member that has not started. Leaves members with outstanding provider intent alone — their outcome is unknown, not absent. |
| **Stop this identity** | Kill switch. Stops FOLLOW and UNFOLLOW campaigns on that account before any provider call. |

**None of these re-follow anyone.** There is no undo, and there is no
control that pretends to be one.

### Reauthorization recovery

Campaign shows `reauthorization_required`. Reconnect the account on
Accounts, then **Resume**. The quota already spent today stays spent —
it describes requests that were made.

### Rate-limit recovery

A 429 stops the run immediately, records the provider's own reset, sets
the campaign to `rate_limited`, and schedules `next_run_at` at or after
that reset. It resumes **the same run** on its own — a second run for
the day would double the day's budget.

If `rate_limited` persists past the reset, check:

```sql
select c.status, c.rate_limited_until, c.next_run_at,
       r.status, r.rate_limited_until, r.rate_limit_remaining
  from public.bluesky_follow_campaigns c
  left join public.bluesky_follow_campaign_runs r
    on r.campaign_id = c.id and r.local_date = current_date
 where c.id = :campaign;
```

### Reconciliation

An action in `reconciliation_required` describes a delete that **may**
have reached a real person and whose outcome was never learned. The
worker reads relationship truth and never re-sends. It resolves when
Bluesky reports the follow is gone.

```sql
select m.subject_did, a.status, a.reconciliation_note, a.follow_rkey,
       m.next_attempt_at
  from public.bluesky_relationship_actions a
  join public.bluesky_follow_campaign_members m on m.id = a.campaign_member_id
 where a.campaign_id = :campaign
   and a.status not in ('succeeded','failed','skipped');
```

Reconciliation proceeds even when the day's quota is exhausted, and is
deferred by 10 minutes between attempts so one ambiguous member cannot
monopolise a tick.

---

## 8. Emergency identity stop

**Fastest, no deploy** — engage the per-identity kill switch from the
campaign page, or:

```sql
insert into public.bluesky_campaign_kill_switches
  (workspace_id, operator_account_id, engaged, reason)
values (:workspace, :identity, true, 'incident')
on conflict (workspace_id, operator_account_id)
do update set engaged = true, reason = excluded.reason, released_at = null;
```

**Whole workspace:** same row with `operator_account_id = null`.

**Whole deployment:** set `BLUESKY_CAMPAIGNS_DISABLED` and redeploy. It
is checked in the route before the database, so it works even if
Postgres is unreachable.

Both dispatchers consult the switch **before any provider call** and
fail closed if the switches cannot be read.

Release by setting `engaged = false, released_at = now()`.

---

## 9. Monitoring and alerts

Run daily, or alert on:

```sql
-- 1. Anything unresolved for more than an hour.
select campaign_id, count(*) from public.bluesky_relationship_actions
 where action_type = 'unfollow'
   and status not in ('succeeded','failed','skipped')
   and started_at < now() - interval '1 hour'
 group by 1;

-- 2. Reservations held, not settled. Should be empty between ticks.
select id, campaign_id, reserved_count, status, expires_at
  from public.bluesky_campaign_quota_reservations
 where status in ('open','held') and expires_at < now() - interval '15 minutes';

-- 3. Identity budget, both kinds.
select operator_account_id, usage_date, attempts_made,
       follows_created, unfollows_deleted, provider_points_spent
  from public.bluesky_identity_daily_usage
 where usage_date >= current_date - 1;

-- 4. Campaigns stuck outside a terminal state with no next run.
select id, name, status, next_run_at from public.bluesky_follow_campaigns
 where kind = 'unfollow' and status = 'active' and next_run_at < now() - interval '1 hour';
```

**Alert thresholds:** any row in (1) older than 6 hours; any row in (2);
`provider_points_spent` above 3,000 for one identity in one day;
`failed_count / attempted_count` above 20% on a run.

---

## 10. How to verify NO DUPLICATE DELETE occurred

Three independent checks. All three must hold.

```sql
-- A. At most ONE non-skipped action per (campaign, member).
--    Enforced by bluesky_campaign_member_action_once; this proves it held.
select campaign_id, campaign_member_id, count(*)
  from public.bluesky_relationship_actions
 where campaign_id = :campaign and status <> 'skipped'
 group by 1,2 having count(*) > 1;
-- expect zero rows

-- B. At most ONE provider intent per member, ever.
select member_id, count(*) from public.bluesky_campaign_attempt_ledger
 where provider_intent_at is not null
   and member_id in (select id from public.bluesky_follow_campaign_members
                      where campaign_id = :campaign)
 group by 1 having count(*) > 1;
-- expect zero rows

-- C. Deletions counted never exceed intents stamped.
select r.attempted_count, r.succeeded_count,
       (select count(*) from public.bluesky_campaign_attempt_ledger l
         where l.run_id = r.id and l.provider_intent_at is not null) as intents
  from public.bluesky_follow_campaign_runs r where r.campaign_id = :campaign;
-- succeeded_count <= intents, and attempted_count = intents
```

---

## 11. How to verify EXACT RECORD OWNERSHIP

Every action row records the record it targeted. Each must name the
acting repository and the follow collection:

```sql
select a.id, a.subject_did, a.actor_did, a.follow_uri, a.follow_rkey,
       m.provider_record_source
  from public.bluesky_relationship_actions a
  join public.bluesky_follow_campaign_members m on m.id = a.campaign_member_id
 where a.campaign_id = :campaign
   and a.action_type = 'unfollow'
   and a.follow_uri is not null
   and a.follow_uri <> 'at://' || a.actor_did || '/app.bsky.graph.follow/' || a.follow_rkey;
-- expect zero rows
```

`provider_record_source` must be `list_records` or `relationship_read`
on every row. There is deliberately no value meaning "derived":

```sql
select provider_record_source, count(*)
  from public.bluesky_follow_campaign_members
 where campaign_id = :campaign group by 1;
```

Cross-check a sample against Bluesky itself — `com.atproto.repo.getRecord`
for a deleted rkey must 404, and `app.bsky.graph.getRelationships` must
report no `following` edge for that subject.

---

## 12. Canary plan — DESIGNED, NOT EXECUTED

Every real unfollow requires explicit operator approval at activation
time. Do not automate any step. Do not proceed to the next step until
the previous one has been reviewed.

| # | Step | What must be true before continuing |
| --- | --- | --- |
| 0 | Apply the migration, verify §2.4, deploy | All four checks pass |
| 1 | **Dry run** over any source | Zero rows in the §6 ledger query; members `skipped`; run counters show 0 attempted |
| 2 | **One explicitly approved test profile** | Exactly one delete in provider logs; §10 A/B/C clean; §11 clean; the profile is genuinely unfollowed on Bluesky |
| 3 | **10 profiles**, quota 100 | As step 2, plus: the run completes, `next_run_at` is tomorrow, no reservation is left open |
| 4 | **100 profiles**, quota 100, over two days | Day 2 creates a NEW run; the identity ceiling is respected across both; no duplicate intent |
| 5 | Review provider logs, ledger rows, run counters, RLS, scheduler | Only then consider a large campaign |

At every step, confirm the Follow subsystem is unaffected: a follow
campaign on the same identity still runs, and its counters move
independently of `unfollows_deleted`.

---

## 13. Known limitations

- **No production verification of any kind.** Nothing was applied,
  deployed, activated or executed.
- **No CSV import.** The repository has no CSV mechanism; the scopes
  offered are the four that exist. Building one was out of scope rather
  than overlooked.
- **`following_records` cannot be counted before it is walked.** The
  confirmation screen says "still building" rather than inventing a
  number.
- **Mutual-relationship, verified-profile, team-account and
  domain-based protection are NOT implemented.** The brief marks them
  optional and warns against silently enabling product-policy
  assumptions; the allowlist and the per-candidate `protected` flag are
  explicit operator choices, and these would not be.
- **The unfollow pass may be skipped** on a tick where the follow pass
  used the invocation. It resumes on the next delivery.
- **PGlite is single-backend.** Every claim about locking is made in
  `two-session.pg.test.ts` against a real server; the PGlite suites say
  so and claim nothing about concurrency.
