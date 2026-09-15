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

-- Reproduced from 20260917000002; the changes are the generation guard
-- in the selection and the cleared stamp on recovery.
create or replace function public.recover_bluesky_reauthorized_campaigns(
  p_workspace_id uuid default null,
  p_account_id uuid default null,
  p_campaign_id uuid default null,
  p_now timestamptz default now()
)
returns table (campaign_id uuid, kind text, run_id uuid, run_resumed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c record;
  v_today date;
  v_run uuid;
begin
  for v_c in
    select f.id, f.kind, f.timezone, f.next_run_at, f.workspace_id
      from public.bluesky_follow_campaigns f
      join public.platform_connections pc
        on pc.workspace_id = f.workspace_id
       and pc.account_id = f.operator_account_id
       and pc.platform = 'bluesky'
     where f.status = 'reauthorization_required'
       and pc.connection_status = 'connected'
       and pc.access_token_encrypted is not null
       -- THE GUARD. A completed session transition moved the generation
       -- past the stop; a status that merely still says `connected` did
       -- not, and does not recover anything.
       and (f.auth_stopped_at_generation is null
            or pc.token_generation > f.auth_stopped_at_generation)
       and (p_workspace_id is null or f.workspace_id = p_workspace_id)
       and (p_account_id is null or f.operator_account_id = p_account_id)
       and (p_campaign_id is null or f.id = p_campaign_id)
     order by f.id
       for update of f
     limit 200
  loop
    update public.bluesky_follow_campaigns f
       set status = 'active',
           last_error_code = null,
           last_error_message = null,
           auth_stopped_at_generation = null,
           next_run_at = greatest(coalesce(f.next_run_at, p_now), p_now)
     where f.id = v_c.id;

    begin
      v_today := (p_now at time zone v_c.timezone)::date;
    exception when others then
      v_today := (p_now at time zone 'UTC')::date;
    end;

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
         or (r.status in ('paused', 'failed')
             and r.last_error_code in (
               'reauthorization_required', 'session_expired', 'not_connected',
               'session_unreadable', 'handle_mismatch'))
       )
     returning r.id into v_run;

    campaign_id := v_c.id;
    kind := v_c.kind;
    run_id := v_run;
    run_resumed := v_run is not null;
    return next;
  end loop;
end;
$$;

revoke all on function public.recover_bluesky_reauthorized_campaigns(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.recover_bluesky_reauthorized_campaigns(uuid, uuid, uuid, timestamptz)
  to service_role;
