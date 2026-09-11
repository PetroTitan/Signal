# Follow Campaigns — observability queries

Run against the production database (read-only). Every query is
workspace-scoped; replace `:workspace_id`.

## Is the scheduler alive?

```sql
-- Runs touched in the last hour. Empty during an execution window
-- means the cron is not firing or nothing is due.
select c.name, r.local_date, r.status,
       r.attempted_count, r.succeeded_count, r.last_chunk_at
  from bluesky_follow_campaign_runs r
  join bluesky_follow_campaigns c on c.id = r.campaign_id
 where r.workspace_id = :workspace_id
   and r.last_chunk_at > now() - interval '1 hour'
 order by r.last_chunk_at desc;
```

## Campaign health, one row each

```sql
select c.name, c.status, c.requested_daily_quota,
       count(*) filter (where m.status in ('queued','retryable'))  as remaining,
       count(*) filter (where m.status = 'succeeded')              as followed,
       count(*) filter (where m.status = 'already_following')      as already,
       count(*) filter (where m.status = 'failed_structural')      as failed,
       count(*) filter (where m.status in ('claimed','running'))   as in_flight,
       c.last_error_message
  from bluesky_follow_campaigns c
  left join bluesky_follow_campaign_members m on m.campaign_id = c.id
 where c.workspace_id = :workspace_id
 group by c.id
 order by c.created_at desc;
```

## Stuck leases — should always be empty

```sql
-- A row here means a worker died AND the next tick has not yet
-- reclaimed it. Self-healing; investigate only if it persists.
select campaign_id, id, status, claimed_by, lease_expires_at,
       now() - lease_expires_at as overdue_by
  from bluesky_follow_campaign_members
 where workspace_id = :workspace_id
   and status in ('claimed','running')
   and lease_expires_at < now()
 order by lease_expires_at;
```

## Effective quota below requested — and why

```sql
select c.name, r.local_date,
       r.requested_daily_quota, r.effective_daily_quota,
       r.effective_quota_reason
  from bluesky_follow_campaign_runs r
  join bluesky_follow_campaigns c on c.id = r.campaign_id
 where r.workspace_id = :workspace_id
   and r.effective_daily_quota < r.requested_daily_quota
 order by r.local_date desc
 limit 30;
```

## Success rate per run — the number that matters

```sql
-- succeeded/attempted, NOT attempted/quota. A run that attempted its
-- full quota and succeeded at none of it is a failure, not a success.
select c.name, r.local_date, r.attempted_count, r.succeeded_count,
       case when r.attempted_count = 0 then null
            else round(100.0 * r.succeeded_count / r.attempted_count, 1)
       end as success_rate_pct,
       r.failed_count, r.status
  from bluesky_follow_campaign_runs r
  join bluesky_follow_campaigns c on c.id = r.campaign_id
 where r.workspace_id = :workspace_id
 order by r.local_date desc
 limit 30;
```

## Per-identity daily consumption

```sql
-- Two campaigns on one identity share this budget.
select u.usage_date, a.handle, u.follows_created, u.attempts_made
  from bluesky_identity_daily_usage u
  join growth_accounts a on a.id = u.operator_account_id
 where u.workspace_id = :workspace_id
 order by u.usage_date desc, u.follows_created desc
 limit 30;
```

## Duplicate-follow audit — must return nothing

```sql
-- The unique index makes this impossible; the query exists so the
-- claim can be checked rather than trusted.
select campaign_id, campaign_member_id, count(*)
  from bluesky_relationship_actions
 where workspace_id = :workspace_id
   and campaign_id is not null
   and campaign_member_id is not null
   and status <> 'skipped'
 group by campaign_id, campaign_member_id
having count(*) > 1;
```

## Engaged kill switches

```sql
select coalesce(a.handle, '(workspace-wide)') as scope,
       k.engaged, k.reason, k.engaged_at
  from bluesky_campaign_kill_switches k
  left join growth_accounts a on a.id = k.operator_account_id
 where k.workspace_id = :workspace_id
   and k.engaged;
```

## Members that will never complete

```sql
select campaign_id, status, count(*)
  from bluesky_follow_campaign_members
 where workspace_id = :workspace_id
   and status in ('failed_structural','protected','skipped')
 group by campaign_id, status
 order by count(*) desc;
```
