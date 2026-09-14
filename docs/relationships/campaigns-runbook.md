# Follow Campaigns — operational runbook

Everything an on-call operator needs when a campaign misbehaves.

---

## How it runs

```
Vercel Cron  */5 * * * *   →  GET /api/campaigns/bluesky/tick
                                ├─ Authorization: Bearer $CRON_SECRET
                                ├─ deploy kill switch?      → return
                                └─ dispatchCampaigns()
                                     for each ACTIVE campaign that is due:
                                       kill switches → window → start date
                                       → exact queue counts
                                       → get-or-create today's run
                                       → compute EFFECTIVE quota
                                       → claim ≤20 atomically, process, persist
                                       → repeat until quota / budget / breaker
```

There is no queue service, no worker process and no timer. A tick either
does bounded work and returns, or does nothing. **Everything that makes
repeated delivery safe is a database constraint**, not application logic:

| Hazard | What stops it |
| --- | --- |
| Two cron deliveries → two daily runs | `unique (campaign_id, local_date)` |
| Two workers → same member | `FOR UPDATE SKIP LOCKED` in the claiming RPC |
| Anything → same member followed twice | `unique (campaign_id, campaign_member_id)` on the action table |
| A bug → attempting more than approved | `CHECK (effective_daily_quota <= requested_daily_quota)` |
| A dead worker → stranded rows | `lease_expires_at`, reclaimed by the same RPC |

## Production rollout after the import hotfix

`20260912000002_campaign_import_production_hotfix.sql` must be present in
the database before deploying the code that calls its RPCs.

1. Set `BLUESKY_CAMPAIGNS_DISABLED=1` and redeploy the environment-only
   change. Confirm the tick reports `disabled:true`.
2. Inspect migration history. If `20260912000001` is absent, apply
   `20260912000001` and `20260912000002` in order. If it is present,
   apply only `20260912000002`.
3. Deploy the matching application commit while the kill switch stays
   engaged.
4. Open `/relationships/campaigns/setup`. It must render source counts,
   not a Server Components digest.
5. Build a dry-run queue and confirm the campaign detail shows a
   non-zero queue. Call the authenticated tick and confirm zero provider
   mutations.
6. Clear `BLUESKY_CAMPAIGNS_DISABLED` only after the dry-run evidence is
   recorded.

The hotfix deliberately re-walks candidate import jobs under the new
immutable snapshot cursor. Existing campaign members are retained and
deduplicated; do not delete or recreate them during rollout.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `CRON_SECRET` | **yes** | What Vercel Cron sends as `Authorization: Bearer`. Already required by the existing crons. Without it the tick returns **503**, never a silent no-op. |
| `SCHEDULER_TICK_TOKEN` | no | Alternative secret for manual `curl` triggering. Either is accepted. |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | The dispatcher has no operator cookie. Without it nothing runs. |
| `TOKEN_ENCRYPTION_KEY` | **yes** | Decrypts the identity's stored Bluesky session. Without it every campaign stops at `reauthorization_required`. |
| `BLUESKY_CAMPAIGNS_DISABLED` | no | **Deploy-level kill switch.** `1`/`true`/`yes` stops every campaign in every workspace, checked before any database read. |
| `BLUESKY_SERVICE` | no | PDS base URL. Defaults to `https://bsky.social`. |

## Stopping things — in order of blast radius

1. **One campaign** — Pause on its page. New claims stop immediately;
   in-flight members finish or lapse. Queue position is untouched.
2. **One identity** — "Stop this identity". Every campaign using that
   Bluesky account stops. Survives a redeploy.
3. **One workspace** — the workspace kill switch. Every campaign in the
   workspace stops.
4. **Everything, everywhere** — set `BLUESKY_CAMPAIGNS_DISABLED=1` and
   redeploy. Checked before the database is touched, so it works even
   if Supabase is the problem.

The switches **fail closed**: if the switch table cannot be read, the
dispatcher stops. An unattended process that follows real people should
not proceed on the assumption that nobody asked it to stop.

## Disabling the scheduler entirely (rollback)

In order of reversibility:

1. `BLUESKY_CAMPAIGNS_DISABLED=1` — instant, no code change.
2. Remove the `/api/campaigns/bluesky/tick` entry from `vercel.json`
   and redeploy — the route stays but nothing calls it.
3. Revert the feature commits. The migration is **additive only**, so
   reverting the code leaves six unused tables and three unused columns;
   nothing existing breaks. There is no down-migration by design — a
   destructive rollback of a table holding the record of real follows
   would destroy the only evidence of what was done.

## Diagnosing "nothing is happening"

Work through these in order; each rules out the one below.

1. **Is the tick being called?**
   `curl -s -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/campaigns/bluesky/tick`
   - `503` → `CRON_SECRET` or `SUPABASE_SERVICE_ROLE_KEY` is missing.
   - `401` → wrong secret.
   - `{"ok":true,"disabled":true}` → the deploy kill switch is set.
   - `{"ok":true,"campaignsConsidered":0}` → no campaign is *due*.
2. **Is the campaign due?** It must be `active`, inside its execution
   window *in its own timezone*, and past its start date. The campaign
   page states the local date and whether it is inside the window.
3. **Is there a kill switch engaged?** The page shows a banner.
4. **Is the effective quota zero?** The page gives the reason verbatim.
   Common: the identity's shared daily ceiling is spent by another
   campaign.
5. **Is the session alive?** `reauthorization_required` means reconnect
   the identity on Accounts.
6. **Is it rate-limited?** The run shows `rate_limited_until`. Nothing
   will be attempted before it. This is correct behaviour, not a fault.

## When a member is stuck

A member in `claimed`/`running` past its `lease_expires_at` is
automatically re-claimed by the next tick — the claiming RPC's
expired-lease branch is the recovery mechanism, and it is safe because
the worker reads relationship truth before re-attempting.

A member in `retryable` with a future `next_attempt_at` is waiting out a
backoff. After `MAX_MEMBER_ATTEMPTS` it becomes `failed_structural` and
is never retried again.

**Nothing is ever left in `running` by a terminal path** — asserted by
test. If you find one, the worker was killed mid-chunk; its lease will
lapse within `LEASE_SECONDS` (300).

## Provider limits worth knowing

From Bluesky's published rate limits:

- **5,000 points/hour, 35,000 points/day per account.** A CREATE is 3
  points ⇒ 1,666 records/hour, **11,666/day**.
- **3,000 API requests per 5 minutes, limited BY IP** — shared across
  Vercel's egress, so this is the tighter constraint in practice.
- `createSession`: **300/day per account**. This is why the session is
  resolved once per campaign per tick and reused across every chunk.

Signal's own ceiling is **1,000 follows/day per identity** — about 8.6%
of the documented daily budget. An unattended system should sit well
inside a limit, and the account is shared with publishing and the manual
workflows.

**None of this is a guarantee.** The same document notes that moderation
systems and application-specific limits may apply, and that bulk
interaction breaches the Community Guidelines. Signal reports what it
actually achieved; it never promises a number.

## Observability

See [`campaigns-observability.md`](./campaigns-observability.md) for the
health queries.

---

## Run recovery after an authentication stop (added 2026-09-14)

See `incident-2026-09-14-expired-token.md` for the incident this
section exists for.

**What you will see when the session dies mid-day.** Campaign
`reauthorization_required`; today's run **`paused`** with
`last_error_code = reauthorization_required` (never `failed`); Accounts
"Sign in again"; zero further provider calls; the member that received
the rejection is `retryable` with its action **re-opened** (`pending`,
no in-flight marker) — not in reconciliation.

**What to do.** Sign the identity in again on Accounts. That is all.
On its next tick the dispatcher sees the connection is `connected`,
probes the session with one `getSession` read, returns the campaign to
`active` and today's run to `running` — same run, same counters — and
continues. Pressing Resume on the campaign does the same thing sooner.

**What will NOT happen.** A second run for the day; a reset of the
day's counters; a duplicate follow for the member that was refused (its
unit was spent; the retry spends a new one under a new reservation, and
the old intent folds as `superseded`); automatic resumption of a
campaign an operator paused.

**Verify.**
```sql
select status, last_error_code, attempted_count, succeeded_count
  from public.bluesky_follow_campaign_runs
 where campaign_id = :campaign and local_date = current_date;
-- running, null, N, M after recovery; paused/reauthorization_required before
```

## Rejected versus ambiguous (added 2026-09-14)

A member whose action is `reconciliation_required` is waiting on a
READ: the response to a request was lost (network, 5xx, unparseable
2xx) and the follow may exist. Nothing is re-sent; ten-minute reads for
two hours, then six-hourly. `reconcile_count` on the member says how
many.

A member whose action is `pending` with `provider_in_flight_at` null
and a `provider_error_code` such as `ExpiredToken` or
`RateLimitExceeded` was REFUSED before any write and is owed a real
retry through the ordinary quota path. The reconciliation takeover does
not claim it; `reopen_bluesky_campaign_action` refuses any code that
does not prove a refusal.

To find members stranded the old way (filed as reconciliation with a
definite rejection recorded) — they heal on the next pass, but to see
them:
```sql
select a.subject_did, a.provider_error_code, a.status
  from public.bluesky_relationship_actions a
 where a.campaign_id = :campaign
   and a.status = 'reconciliation_required'
   and a.provider_error_code in ('ExpiredToken','InvalidToken','RateLimitExceeded','session_expired');
```

## The conservation equation (added 2026-09-14)

```sql
select * from public.bluesky_campaign_conservation(:workspace, :campaign);
-- categorised_total = queued_total, always.
-- actionable_remaining = pending + running + retryable + reconciliation_required.
select public.bluesky_campaign_may_complete(:workspace, :campaign);
-- true only when actionable_remaining = 0 AND no open lease, reservation,
-- outstanding intent or unresolved action.
```
