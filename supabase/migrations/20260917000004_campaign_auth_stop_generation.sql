-- =====================================================================
-- Campaign authentication stops record the identity's token generation;
-- recovery requires the generation to have moved.
-- =====================================================================
--
-- Forward-only. Every earlier migration remains byte-identical. Takes
-- the next free slot after the LinkedIn migrations (…000003).
--
-- PRODUCTION, 2026-09-15 15:35:47Z (Vercel request
-- 7ggxw-1789486547108-3213ab3ab693), identity
-- a9411a9b-dfd6-4d71-95f0-8874b2708cf8, connection
-- 4ad3bd2a-950b-41ce-aaa2-0b736bd01de3.
--
-- A worker whose session reads had been served by Next's Data Cache
-- was told to reload, reloaded the same stale row, retried the same
-- expired JWT, and stopped its campaign "for reauthorization" — while
-- the identity's row said connected / healthy / generation 1, because
-- the coordinator never marked it (nothing had been decided about the
-- credential). `recover_bluesky_reauthorized_campaigns` then saw the
-- `connected` status, reactivated the campaign, and the next delivery
-- stopped it again. Campaign state and identity state contradicted
-- each other and the loop had no exit.
--
-- The transport defect is fixed in the application (every service-role
-- request now bypasses the Data Cache; a second rejection after a
-- renewal yields instead of claiming the identity was marked). This
-- migration closes the remaining hole in the RECOVERY rule: a campaign
-- stopped for authentication records the identity's token generation at
-- that moment, and recovery requires the generation to have MOVED past
-- it — a session transition that actually completed (a coordinator
-- commit, an App-Password reconnect, a successful "Check account
-- access") — never a `connected` flag that was true all along.
--
-- Legacy rows (stopped before this column existed) carry null and are
-- recovered once, as before. On recovery the stamp is cleared.
--
-- Lock order unchanged: platform_connections (FOR UPDATE) →
-- growth_accounts → bluesky_follow_campaigns (ORDER BY id, FOR UPDATE)
-- → bluesky_follow_campaign_runs. `stop_bluesky_campaigns_for_identity`
-- now takes the identity row first itself, so a caller that does not
-- already hold it (the dispatcher) locks in the same order as one that
-- does (`fail_bluesky_refresh`).
--
-- No RPC returns a token. Grants restated: service_role only.

set search_path = public;

alter table public.bluesky_follow_campaigns
  add column if not exists auth_stopped_at_generation bigint;

comment on column public.bluesky_follow_campaigns.auth_stopped_at_generation is
  'platform_connections.token_generation when the campaign was stopped for authentication. Recovery requires the identity generation to exceed it. Null = never stopped, or stopped before this column existed (recovered once when connected).';

-- Reproduced from 20260917000002; the changes are the identity lock,
-- the generation read and the stamp.
create or replace function public.stop_bluesky_campaigns_for_identity(
  p_workspace_id uuid,
  p_account_id uuid,
  p_message text
)
returns table (campaigns_stopped integer, runs_stopped integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign record;
  v_n integer;
  v_generation bigint;
begin
  campaigns_stopped := 0;
  runs_stopped := 0;

  -- The identity row first. Free when the caller already holds it.
  select pc.token_generation into v_generation
    from public.platform_connections pc
   where pc.workspace_id = p_workspace_id
     and pc.account_id = p_account_id
     and pc.platform = 'bluesky'
     for update;

  for v_campaign in
    select id
      from public.bluesky_follow_campaigns
     where workspace_id = p_workspace_id
       and operator_account_id = p_account_id
       and status = 'active'
     order by id
       for update
  loop
    update public.bluesky_follow_campaigns f
       set status = 'reauthorization_required',
           last_error_code = 'reauthorization_required',
           last_error_message = p_message,
           auth_stopped_at_generation = v_generation
     where f.id = v_campaign.id;
    campaigns_stopped := campaigns_stopped + 1;

    update public.bluesky_follow_campaign_runs r
       set status = 'waiting_for_auth',
           last_error_code = 'reauthorization_required',
           last_error_message = p_message
     where r.workspace_id = p_workspace_id
       and r.campaign_id = v_campaign.id
       and r.status = 'running';
    get diagnostics v_n = row_count;
    runs_stopped := runs_stopped + v_n;
  end loop;
  return next;
end;
$$;

revoke all on function public.stop_bluesky_campaigns_for_identity(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.stop_bluesky_campaigns_for_identity(uuid, uuid, text)
  to service_role;

-- =====================================================================
-- Recovery, widened — the third finding of 2026-09-15
-- =====================================================================
--
-- After the operator reconnected, campaign cdbb2b76-998c-4cdf-a235-78f629eebc9a
-- was `active` with today's run `waiting_for_auth` (20 attempted, 18
-- succeeded, last success 15:35:55Z) and the identity's other active
-- campaign kept an authentication-stopped run too. The sweep the fair
-- round runs — this function — selected only
-- `f.status = 'reauthorization_required'`, so that valid combination
-- was excluded before the run was ever inspected. No number of
-- deliveries could repair it through the sweep.
--
-- The function now repairs three shapes, all requiring the identity's
-- Bluesky connection (same workspace, account, platform) to be
-- `connected` with an encrypted access token present:
--
--   A. campaign `reauthorization_required` — and, if the stop was
--      stamped, the identity's generation has moved past the stamp;
--   B. campaign `active` while today's run (in the campaign's timezone)
--      is `waiting_for_auth`;
--   C. campaign `active` or `reauthorization_required` while today's
--      run is in the pre-coordinator shape: `paused`/`failed` with a
--      recoverable authentication code.
--
-- Never a campaign that is `paused` (the operator's), `cancelled`,
-- `completed`, `draft`, `ready`, `building_queue`, `rate_limited` or
-- `failed`. Never a run stopped for a non-recoverable reason.
--
-- Within one transaction, per campaign, in this lock order:
--   bluesky_follow_campaigns (ORDER BY id, FOR UPDATE)
--     → bluesky_follow_campaign_runs
-- (platform_connections is read, not locked: a concurrent commit can
-- only move the generation forward and make more campaigns eligible on
-- the next sweep.) The campaign becomes or stays `active`; only
-- recoverable system error fields are cleared; the SAME current-day run
-- returns to `running` with its id, quota, counters, reservations,
-- attempts and queue untouched; prior-day `waiting_for_auth` runs are
-- closed with an explicit reason; `next_run_at` becomes due now — the
-- dispatcher's own start-date and execution-window checks still apply.
--
-- Bounded and keyset-paged (`p_after_campaign_id`, `p_limit`, ORDER BY
-- id): no OFFSET, a caller walks pages by the last id returned. The
-- signature gained two defaulted parameters, so the previous signature
-- is DROPPED first — otherwise named-argument calls (including
-- `commit_bluesky_refreshed_session`'s) would be ambiguous.

create or replace function public.bluesky_local_date_safe(p_at timestamptz, p_tz text)
returns date
language plpgsql
immutable
as $$
begin
  return (p_at at time zone coalesce(p_tz, 'UTC'))::date;
exception when others then
  return (p_at at time zone 'UTC')::date;
end;
$$;

revoke all on function public.bluesky_local_date_safe(timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.bluesky_local_date_safe(timestamptz, text)
  to service_role;

drop function if exists public.recover_bluesky_reauthorized_campaigns(uuid, uuid, uuid, timestamptz);

create or replace function public.recover_bluesky_reauthorized_campaigns(
  p_workspace_id uuid default null,
  p_account_id uuid default null,
  p_campaign_id uuid default null,
  p_now timestamptz default now(),
  p_after_campaign_id uuid default null,
  p_limit integer default 200
)
returns table (
  campaign_id uuid,
  kind text,
  run_id uuid,
  run_resumed boolean,
  previous_status text,
  next_run_at timestamptz,
  identity_id uuid,
  token_generation bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c record;
  v_today date;
  v_run uuid;
  v_status text;
  v_stamp bigint;
  v_recoverable constant text[] := array[
    'reauthorization_required', 'session_expired', 'not_connected',
    'session_unreadable', 'handle_mismatch'
  ];
begin
  for v_c in
    select f.id, f.kind, f.timezone, f.workspace_id, f.status, f.operator_account_id,
           f.last_error_code, pc.token_generation as gen
      from public.bluesky_follow_campaigns f
      join public.platform_connections pc
        on pc.workspace_id = f.workspace_id
       and pc.account_id = f.operator_account_id
       and pc.platform = 'bluesky'
     where pc.connection_status = 'connected'
       and pc.access_token_encrypted is not null
       and f.status in ('active', 'reauthorization_required')
       and (p_workspace_id is null or f.workspace_id = p_workspace_id)
       and (p_account_id is null or f.operator_account_id = p_account_id)
       and (p_campaign_id is null or f.id = p_campaign_id)
       and (p_after_campaign_id is null or f.id > p_after_campaign_id)
       and (
         -- A. stopped for authentication; a completed session transition
         --    moved the generation past the stamp (null = legacy stop).
         --    The run — waiting, or a legacy paused/failed shape — comes
         --    back with the campaign below.
         (f.status = 'reauthorization_required'
          and (f.auth_stopped_at_generation is null
               or pc.token_generation > f.auth_stopped_at_generation))
         or
         -- B/C. an ACTIVE campaign whose run for today is stopped by the
         --      SYSTEM for authentication. Only active: a stamped
         --      reauthorization_required campaign must wait for its
         --      generation to move, whatever its run says.
         (f.status = 'active' and exists (
           select 1
             from public.bluesky_follow_campaign_runs r
            where r.workspace_id = f.workspace_id
              and r.campaign_id = f.id
              and r.local_date = public.bluesky_local_date_safe(p_now, f.timezone)
              and (r.status = 'waiting_for_auth'
                   or (r.status in ('paused', 'failed')
                       and r.last_error_code = any (v_recoverable)))
         ))
       )
     order by f.id
       for update of f
     limit greatest(1, least(coalesce(p_limit, 200), 500))
  loop
    v_today := public.bluesky_local_date_safe(p_now, v_c.timezone);

    -- RE-VERIFY UNDER THE LOCK. A concurrent sweep may have recovered
    -- this campaign between our snapshot and our lock: under READ
    -- COMMITTED the row lock waits for it and re-evaluates the row's
    -- own quals, but the run subquery still sees our older snapshot. A
    -- fresh statement sees the committed state; a campaign that is
    -- already repaired is skipped, so two simultaneous sweeps report
    -- each campaign exactly once.
    select f.status, f.auth_stopped_at_generation
      into v_status, v_stamp
      from public.bluesky_follow_campaigns f
     where f.id = v_c.id;
    if not (
      (v_status = 'reauthorization_required'
        and (v_stamp is null or v_c.gen > v_stamp))
      or (v_status = 'active' and exists (
           select 1 from public.bluesky_follow_campaign_runs r
            where r.workspace_id = v_c.workspace_id and r.campaign_id = v_c.id
              and r.local_date = v_today
              and (r.status = 'waiting_for_auth'
                   or (r.status in ('paused', 'failed')
                       and r.last_error_code = any (v_recoverable)))))
    ) then
      continue;
    end if;
    previous_status := v_status;

    update public.bluesky_follow_campaigns f
       set status = 'active',
           last_error_code = case when f.last_error_code = any (v_recoverable) then null else f.last_error_code end,
           last_error_message = case when f.last_error_code = any (v_recoverable) then null else f.last_error_message end,
           auth_stopped_at_generation = null,
           next_run_at = p_now
     where f.id = v_c.id;

    update public.bluesky_follow_campaign_runs r
       set status = 'completed',
           completed_at = p_now,
           effective_quota_reason = 'day ended while waiting for reauthorization',
           last_error_code = null,
           last_error_message = null
     where r.workspace_id = v_c.workspace_id
       and r.campaign_id = v_c.id
       and r.status = 'waiting_for_auth'
       and r.local_date < v_today;

    v_run := null;
    update public.bluesky_follow_campaign_runs r
       set status = 'running',
           rate_limited_until = null,
           last_error_code = null,
           last_error_message = null
     where r.workspace_id = v_c.workspace_id
       and r.campaign_id = v_c.id
       and r.local_date = v_today
       and (
         r.status = 'waiting_for_auth'
         or (r.status in ('paused', 'failed') and r.last_error_code = any (v_recoverable))
       )
     returning r.id into v_run;

    campaign_id := v_c.id;
    kind := v_c.kind;
    run_id := v_run;
    run_resumed := v_run is not null;
    next_run_at := p_now;
    identity_id := v_c.operator_account_id;
    token_generation := v_c.gen;
    return next;
  end loop;
end;
$$;

revoke all on function public.recover_bluesky_reauthorized_campaigns(uuid, uuid, uuid, timestamptz, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.recover_bluesky_reauthorized_campaigns(uuid, uuid, uuid, timestamptz, uuid, integer)
  to service_role;

-- =====================================================================
-- Health: the combination that must normally be empty
-- =====================================================================
--
-- A connected identity whose campaign is `active` (or still
-- `reauthorization_required`) while today's run is stopped by the
-- system for authentication. The sweep above empties it on every
-- delivery; a row that survives two cron intervals is an alert.

create or replace function public.bluesky_recovery_health()
returns table (
  workspace_id uuid,
  identity_id uuid,
  campaign_id uuid,
  campaign_status text,
  run_id uuid,
  run_status text,
  local_date date,
  token_generation bigint,
  shape text
)
language sql
stable
security definer
set search_path = public
as $$
  select f.workspace_id, f.operator_account_id, f.id, f.status, r.id, r.status, r.local_date,
         pc.token_generation,
         case when f.status = 'active' then 'active_waiting' else 'reauthorization_required_waiting' end
    from public.bluesky_follow_campaigns f
    join public.platform_connections pc
      on pc.workspace_id = f.workspace_id
     and pc.account_id = f.operator_account_id
     and pc.platform = 'bluesky'
     and pc.connection_status = 'connected'
    join public.bluesky_follow_campaign_runs r
      on r.workspace_id = f.workspace_id
     and r.campaign_id = f.id
     and r.local_date = public.bluesky_local_date_safe(now(), f.timezone)
   where f.status in ('active', 'reauthorization_required')
     and (r.status = 'waiting_for_auth'
          or (r.status in ('paused', 'failed')
              and r.last_error_code in ('reauthorization_required', 'session_expired', 'not_connected',
                                        'session_unreadable', 'handle_mismatch')))
   order by f.id;
$$;

revoke all on function public.bluesky_recovery_health()
  from public, anon, authenticated;
grant execute on function public.bluesky_recovery_health()
  to service_role;
