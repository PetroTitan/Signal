-- =====================================================================
-- Bluesky identity-session coordination — one refresh per identity,
-- generation-checked, atomic with campaign recovery.
-- =====================================================================
--
-- Forward-only. Every earlier migration remains byte-identical.
-- (20260917000001 is reserved by unrelated in-flight work; this file
-- deliberately takes the next slot.)
--
-- PRODUCTION INCIDENT, 2026-09-15 (campaign "webmasterid-auto-300",
-- identity @webmasterid.bsky.social, which also carries "WebmasterID 1-3")
-- ----------------------------------------------------------------------
-- A routine access-token expiry stopped a campaign, and a later
-- successful refresh of the SAME identity did not bring it back:
--
--   * Access and refresh tokens belong to the identity, and Bluesky
--     refresh tokens are single-use: whoever presents one first rotates
--     it, and every later presentation of the same token is refused.
--     Nothing serialised the refresh across the workers that share an
--     identity — a second campaign on the same account, the publishing
--     scheduler on the same */5 cron, a duplicate cron delivery, the
--     operator's "Check account access". The loser's refresh was
--     refused, and the loser wrote `expired` OVER the winner's freshly
--     persisted, perfectly valid pair. (Reproduced: scenario C in
--     src/core/bluesky-campaigns/incident-2026-09-15.pg.test.ts.)
--
--   * A successful refresh wrote `connected` to platform_connections
--     but never to the growth_accounts mirror; a failed one wrote
--     `expired` to both. Campaign recovery gated on the mirror, so
--     after one stale failure no later refresh could recover anything
--     — the connection said healthy, the campaign said
--     reauthorization_required, and both stayed that way. (Scenario D.)
--
--   * Recovery was per campaign and probe-based, separate from the
--     refresh that proved the session worked. The two were not atomic.
--
-- WHAT THIS MIGRATION ADDS
-- ------------------------
--   1. `platform_connections.token_generation` — a monotonic counter,
--      bumped by trigger whenever either token column changes, so EVERY
--      writer (coordinated or not) moves it. It is the compare-and-swap
--      key: a worker that read generation N may act on the identity only
--      while the stored generation is still N.
--   2. `refresh_lease_owner` / `refresh_lease_expires_at` — a short
--      database lease that serialises provider refresh calls per
--      identity (workspace, account, platform). A crashed owner's lease
--      simply expires.
--   3. RPCs, service_role-only, that are the ONLY way the application
--      changes an identity's session state on the refresh path:
--        acquire_bluesky_refresh_lease      → acquired | reload | busy |
--                                             reauthorization_required |
--                                             not_connected
--        commit_bluesky_refreshed_session   → persists the rotated pair,
--                                             generation+1, connected /
--                                             healthy, mirrors the
--                                             identity, AND recovers every
--                                             campaign and run of that
--                                             identity — in ONE transaction
--        fail_bluesky_refresh               → marks reauthorization_required
--                                             ONLY for the owner of the
--                                             lease, on the latest
--                                             generation, for a DEFINITIVE
--                                             rejection; and stops every
--                                             active campaign of the identity
--        release_bluesky_refresh_lease
--        recover_bluesky_reauthorized_campaigns
--                                           → campaigns stopped for
--                                             authentication whose identity
--                                             is connected return to active;
--                                             today's run returns to running
--        stop_bluesky_campaigns_for_identity
--   4. A run status `waiting_for_auth`, distinct from `paused`, so a
--      system stop for authentication never shares a state — or an
--      automatic transition — with an operator's pause.
--
-- NO TOKEN LEAVES SQL. The RPCs accept encrypted blobs as arguments and
-- return verdicts, generations and counts only. No function here returns
-- a token column, encrypted or otherwise.
--
-- LOCK ORDER (documented, tested)
-- --------------------------------
--   platform_connections (identity row, FOR UPDATE)
--     → growth_accounts (identity mirror)
--       → bluesky_follow_campaigns (ORDER BY id, FOR UPDATE)
--         → bluesky_follow_campaign_runs
-- None of these functions touches identity usage, reservations, the
-- ledger, actions or members, so this order is disjoint from the quota
-- order (usage → run → reservation → ledger → action) and cannot form a
-- cycle with it. Re-acquiring a lock already held is free, so the
-- functions may call each other.
--
-- Deploy order: this migration BEFORE the application. Every new column
-- has a default, every new RPC is additive, and the widened run status
-- is written only by the new code.

set search_path = public;

-- =====================================================================
-- 1. Generation and lease columns
-- =====================================================================

alter table public.platform_connections
  add column if not exists token_generation bigint not null default 0,
  add column if not exists refresh_lease_owner text,
  add column if not exists refresh_lease_expires_at timestamptz;

comment on column public.platform_connections.token_generation is
  'Monotonic. Bumped by trigger whenever access_token_encrypted or refresh_token_encrypted changes. The compare-and-swap key for session coordination: never reused, never reset.';
comment on column public.platform_connections.refresh_lease_owner is
  'Owner of the in-progress provider refresh for this identity, or null. A lease serialises refreshSession calls; it is not a lock on the row.';
comment on column public.platform_connections.refresh_lease_expires_at is
  'When the refresh lease lapses on its own. A crashed owner is recovered by expiry, never by an operator.';

create or replace function public.platform_connection_token_generation_bump()
returns trigger
language plpgsql
as $$
begin
  if (new.access_token_encrypted is distinct from old.access_token_encrypted
      or new.refresh_token_encrypted is distinct from old.refresh_token_encrypted)
     and new.token_generation = old.token_generation
  then
    new.token_generation := old.token_generation + 1;
  end if;
  -- Never let a writer move the generation backwards.
  if new.token_generation < old.token_generation then
    new.token_generation := old.token_generation;
  end if;
  return new;
end;
$$;

drop trigger if exists platform_connections_token_generation
  on public.platform_connections;
create trigger platform_connections_token_generation
  before update on public.platform_connections
  for each row execute function public.platform_connection_token_generation_bump();

-- =====================================================================
-- 2. A run state for "waiting for the identity", distinct from paused
-- =====================================================================
--
-- `paused` is what an operator's pause and what the system's
-- authentication stop both wrote; they were told apart only by
-- last_error_code. Widening a CHECK admits a value; it invalidates no
-- existing row and changes no existing behaviour.

do $$
begin
  alter table public.bluesky_follow_campaign_runs
    drop constraint if exists bluesky_follow_campaign_runs_status_check;
  alter table public.bluesky_follow_campaign_runs
    add constraint bluesky_follow_campaign_runs_status_check
    check (status in (
      'running',
      'completed',
      'paused',            -- stopped by the system for a non-auth reason
                           -- (breaker, halted quota) or by an operator
      'waiting_for_auth',  -- stopped by the system because the IDENTITY
                           -- needs the operator; resumes automatically
      'rate_limited',
      'failed',
      'cancelled'
    ));
end;
$$;

create index if not exists bluesky_follow_campaigns_reauth_idx
  on public.bluesky_follow_campaigns (workspace_id, operator_account_id)
  where status = 'reauthorization_required';

-- =====================================================================
-- 3. Stopping and recovering every campaign of an identity
-- =====================================================================

-- Every ACTIVE campaign of the identity → reauthorization_required, and
-- each such campaign's RUNNING run → waiting_for_auth. Never a paused,
-- rate-limited, completed or cancelled campaign; never a run that is not
-- running. Counters untouched.
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
begin
  campaigns_stopped := 0;
  runs_stopped := 0;
  for v_campaign in
    select id
      from public.bluesky_follow_campaigns
     where workspace_id = p_workspace_id
       and operator_account_id = p_account_id
       and status = 'active'
     order by id
       for update
  loop
    update public.bluesky_follow_campaigns
       set status = 'reauthorization_required',
           last_error_code = 'reauthorization_required',
           last_error_message = p_message
     where id = v_campaign.id;
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

-- Campaigns stopped for authentication whose identity's Bluesky
-- connection is `connected` again return to `active`, with their error
-- fields cleared and `next_run_at` due no later than now (a scheduled
-- FUTURE date is kept; the dispatcher's own window and start-date checks
-- still apply). Today's run — in the campaign's timezone — returns to
-- `running` from `waiting_for_auth`, or from the pre-coordinator shape
-- (`paused`/`failed` with a recoverable authentication code). Counters
-- are never touched; no second run is ever created. A `waiting_for_auth`
-- run from an EARLIER day is closed as completed with the reason
-- recorded, so a past day cannot show as waiting forever.
--
-- NEVER touches a campaign an operator paused: that campaign is `paused`,
-- not `reauthorization_required`, and is not selected.
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
       and (p_workspace_id is null or f.workspace_id = p_workspace_id)
       and (p_account_id is null or f.operator_account_id = p_account_id)
       and (p_campaign_id is null or f.id = p_campaign_id)
     order by f.id
       for update of f
     limit 200
  loop
    -- Every column below is alias-qualified: the OUT columns of this
    -- function (campaign_id, kind, run_id) are plpgsql variables and
    -- would otherwise make an unqualified `campaign_id` ambiguous.
    update public.bluesky_follow_campaigns f
       set status = 'active',
           last_error_code = null,
           last_error_message = null,
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

-- =====================================================================
-- 4. The refresh lease
-- =====================================================================
--
-- Verdicts, for a caller that read the identity at p_observed_generation:
--   acquired                  — nobody else is refreshing, the stored
--                               generation is still the one the caller
--                               saw: the caller must refresh, once.
--   reload                    — the stored generation differs: someone
--                               already refreshed or reconnected. The
--                               caller must reload and use the latest
--                               session; it must NOT call the provider.
--   busy                      — another owner holds an unexpired lease.
--                               Wait briefly and ask again.
--   reauthorization_required  — the identity needs the operator at this
--                               very generation. No provider call.
--   not_connected             — no Bluesky connection row.
create or replace function public.acquire_bluesky_refresh_lease(
  p_workspace_id uuid,
  p_account_id uuid,
  p_owner text,
  p_observed_generation bigint,
  p_lease_seconds integer default 30
)
returns table (verdict text, generation bigint, connection_status text, lease_expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.platform_connections;
begin
  if p_owner is null or length(p_owner) = 0 then
    raise exception 'refresh lease owner is required';
  end if;

  select pc.* into v_conn
    from public.platform_connections pc
   where pc.workspace_id = p_workspace_id
     and pc.account_id = p_account_id
     and pc.platform = 'bluesky'
     for update;

  if v_conn.id is null then
    verdict := 'not_connected'; generation := null; connection_status := null;
    lease_expires_at := null; return next; return;
  end if;

  generation := v_conn.token_generation;
  connection_status := v_conn.connection_status;

  if v_conn.token_generation is distinct from p_observed_generation then
    verdict := 'reload'; lease_expires_at := null; return next; return;
  end if;

  if v_conn.connection_status in ('reauthorization_required', 'revoked', 'not_connected', 'disabled', 'error') then
    verdict := 'reauthorization_required'; lease_expires_at := null; return next; return;
  end if;

  if v_conn.refresh_lease_owner is not null
     and v_conn.refresh_lease_owner <> p_owner
     and v_conn.refresh_lease_expires_at is not null
     and v_conn.refresh_lease_expires_at > now()
  then
    verdict := 'busy'; lease_expires_at := v_conn.refresh_lease_expires_at; return next; return;
  end if;

  update public.platform_connections
     set refresh_lease_owner = p_owner,
         refresh_lease_expires_at =
           now() + make_interval(secs => greatest(1, least(coalesce(p_lease_seconds, 30), 300)))
   where id = v_conn.id
   returning refresh_lease_expires_at into lease_expires_at;

  verdict := 'acquired';
  return next;
end;
$$;

revoke all on function public.acquire_bluesky_refresh_lease(uuid, uuid, text, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.acquire_bluesky_refresh_lease(uuid, uuid, text, bigint, integer)
  to service_role;

create or replace function public.release_bluesky_refresh_lease(
  p_workspace_id uuid,
  p_account_id uuid,
  p_owner text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.platform_connections pc
     set refresh_lease_owner = null,
         refresh_lease_expires_at = null
   where pc.workspace_id = p_workspace_id
     and pc.account_id = p_account_id
     and pc.platform = 'bluesky'
     and pc.refresh_lease_owner = p_owner;
  return found;
end;
$$;

revoke all on function public.release_bluesky_refresh_lease(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.release_bluesky_refresh_lease(uuid, uuid, text)
  to service_role;

-- =====================================================================
-- 5. Committing a refreshed session — and recovering the campaigns
-- =====================================================================
--
-- The compare-and-swap is the GENERATION, not the lease. A caller whose
-- lease lapsed during a slow provider call still holds the only valid
-- rotated pair for this generation (the provider consumed the previous
-- refresh token when it answered), so refusing it would throw away the
-- identity's only working credential. A caller whose generation has
-- moved — someone reconnected or refreshed meanwhile — is refused, and
-- the newer pair stands; the caller reloads it.
--
-- Everything below is one transaction: tokens, generation, connection
-- status, identity mirror, campaign and run recovery. There is no
-- instant at which the connection says connected and a campaign of that
-- identity is still stopped for authentication.
create or replace function public.commit_bluesky_refreshed_session(
  p_workspace_id uuid,
  p_account_id uuid,
  p_owner text,
  p_expected_generation bigint,
  p_access_token_encrypted text,
  p_refresh_token_encrypted text,
  p_provider_account_id text,
  p_handle text,
  p_message text,
  p_now timestamptz default now()
)
returns table (committed boolean, generation bigint, reason text,
               campaigns_recovered integer, runs_resumed integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.platform_connections;
  v_recovered integer := 0;
  v_resumed integer := 0;
begin
  campaigns_recovered := 0;
  runs_resumed := 0;

  if p_access_token_encrypted is null or length(p_access_token_encrypted) = 0 then
    raise exception 'an encrypted access token is required to commit a session';
  end if;

  select pc.* into v_conn
    from public.platform_connections pc
   where pc.workspace_id = p_workspace_id
     and pc.account_id = p_account_id
     and pc.platform = 'bluesky'
     for update;

  if v_conn.id is null then
    committed := false; generation := null; reason := 'not_connected';
    return next; return;
  end if;

  if v_conn.token_generation is distinct from p_expected_generation then
    -- A newer generation exists. Ours is discarded; theirs stands.
    if v_conn.refresh_lease_owner = p_owner then
      update public.platform_connections
         set refresh_lease_owner = null, refresh_lease_expires_at = null
       where id = v_conn.id;
    end if;
    committed := false; generation := v_conn.token_generation; reason := 'generation_moved';
    return next; return;
  end if;

  update public.platform_connections
     set access_token_encrypted = p_access_token_encrypted,
         refresh_token_encrypted = p_refresh_token_encrypted,
         token_generation = v_conn.token_generation + 1,
         connection_status = 'connected',
         health_status = 'healthy',
         provider_account_id = coalesce(p_provider_account_id, provider_account_id),
         handle = coalesce(p_handle, handle),
         display_name = coalesce(p_handle, display_name),
         connected_at = p_now,
         last_checked_at = p_now,
         revoked_at = null,
         metadata = (coalesce(metadata, '{}'::jsonb) - 'handle_mismatch')
                    || jsonb_build_object(
                         'verification_method', 'atproto.server.refreshSession',
                         'last_message', coalesce(p_message, 'Session refreshed.'),
                         'token_generation', v_conn.token_generation + 1),
         refresh_lease_owner = null,
         refresh_lease_expires_at = null
   where id = v_conn.id;

  update public.growth_accounts g
     set connection_status = 'connected'
   where g.workspace_id = p_workspace_id
     and g.id = p_account_id;

  select count(*), count(*) filter (where r.run_resumed)
    into v_recovered, v_resumed
    from public.recover_bluesky_reauthorized_campaigns(
           p_workspace_id := p_workspace_id,
           p_account_id := p_account_id,
           p_campaign_id := null,
           p_now := p_now) r;

  committed := true;
  generation := v_conn.token_generation + 1;
  reason := null;
  campaigns_recovered := v_recovered;
  runs_resumed := v_resumed;
  return next;
end;
$$;

revoke all on function public.commit_bluesky_refreshed_session(
  uuid, uuid, text, bigint, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.commit_bluesky_refreshed_session(
  uuid, uuid, text, bigint, text, text, text, text, text, timestamptz)
  to service_role;

-- =====================================================================
-- 6. A failed refresh — guarded three ways
-- =====================================================================
--
-- The identity is marked reauthorization_required ONLY when all of:
--   * the caller still owns an unexpired refresh lease,
--   * the stored generation is the one the caller attempted,
--   * the failure is DEFINITIVE (p_definitive: the provider rejected the
--     refresh token, or there was none) — a network error or a 5xx
--     changes nothing about the identity and simply releases the lease.
-- A stale caller — one whose generation has moved — can never overwrite
-- a newer healthy session, whatever it saw. The lease is released in
-- every case where the caller holds it.
--
-- When the identity is marked, every ACTIVE campaign of the identity is
-- stopped in the same transaction (stop_bluesky_campaigns_for_identity),
-- so no further provider mutation is issued for it by any worker.
create or replace function public.fail_bluesky_refresh(
  p_workspace_id uuid,
  p_account_id uuid,
  p_owner text,
  p_expected_generation bigint,
  p_definitive boolean,
  p_message text,
  p_now timestamptz default now()
)
returns table (applied boolean, generation bigint, connection_status text, reason text,
               campaigns_stopped integer, runs_stopped integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.platform_connections;
  v_owned boolean;
  v_stopped record;
begin
  campaigns_stopped := 0;
  runs_stopped := 0;

  select pc.* into v_conn
    from public.platform_connections pc
   where pc.workspace_id = p_workspace_id
     and pc.account_id = p_account_id
     and pc.platform = 'bluesky'
     for update;

  if v_conn.id is null then
    applied := false; generation := null; connection_status := null; reason := 'not_connected';
    return next; return;
  end if;

  generation := v_conn.token_generation;
  connection_status := v_conn.connection_status;
  v_owned := v_conn.refresh_lease_owner = p_owner
             and v_conn.refresh_lease_expires_at is not null
             and v_conn.refresh_lease_expires_at > now();

  if v_conn.refresh_lease_owner = p_owner then
    update public.platform_connections
       set refresh_lease_owner = null, refresh_lease_expires_at = null
     where id = v_conn.id;
  end if;

  if v_conn.token_generation is distinct from p_expected_generation then
    applied := false; reason := 'generation_moved'; return next; return;
  end if;
  if not p_definitive then
    update public.platform_connections
       set last_checked_at = p_now,
           metadata = coalesce(metadata, '{}'::jsonb)
                      || jsonb_build_object('last_message', coalesce(p_message, 'Refresh could not be completed.'))
     where id = v_conn.id;
    applied := false; reason := 'transient'; return next; return;
  end if;
  if not v_owned then
    applied := false; reason := 'lease_lost'; return next; return;
  end if;

  update public.platform_connections
     set connection_status = 'reauthorization_required',
         health_status = 'expired',
         last_checked_at = p_now,
         metadata = coalesce(metadata, '{}'::jsonb)
                    || jsonb_build_object('last_message', coalesce(p_message, 'Refresh rejected.'))
   where id = v_conn.id;

  update public.growth_accounts g
     set connection_status = 'reauthorization_required'
   where g.workspace_id = p_workspace_id
     and g.id = p_account_id;

  select * into v_stopped
    from public.stop_bluesky_campaigns_for_identity(p_workspace_id, p_account_id, p_message);

  applied := true;
  connection_status := 'reauthorization_required';
  reason := 'marked';
  campaigns_stopped := coalesce(v_stopped.campaigns_stopped, 0);
  runs_stopped := coalesce(v_stopped.runs_stopped, 0);
  return next;
end;
$$;

revoke all on function public.fail_bluesky_refresh(uuid, uuid, text, bigint, boolean, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.fail_bluesky_refresh(uuid, uuid, text, bigint, boolean, text, timestamptz)
  to service_role;

-- =====================================================================
-- 7. The recovery resume also moves the new run state
-- =====================================================================
--
-- Reproduced from the LAST definition (20260915000001 §D); the only
-- change is that `waiting_for_auth` is a state this function may leave.

create or replace function public.resume_bluesky_campaign_run_after_recovery(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_local_date date
)
returns table (resumed boolean, run_id uuid, run_status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.bluesky_follow_campaign_runs;
begin
  select * into v_run
    from public.bluesky_follow_campaign_runs
   where workspace_id = p_workspace_id
     and campaign_id = p_campaign_id
     and local_date = p_local_date
   for update;

  if v_run.id is null then
    resumed := false; run_id := null; run_status := null;
    return next; return;
  end if;

  if v_run.status = 'running' then
    resumed := false; run_id := v_run.id; run_status := v_run.status;
    return next; return;
  end if;

  if v_run.status in ('paused', 'failed', 'rate_limited', 'waiting_for_auth')
     and (v_run.rate_limited_until is null or v_run.rate_limited_until <= now())
  then
    update public.bluesky_follow_campaign_runs
       set status = 'running',
           rate_limited_until = null,
           last_error_code = null,
           last_error_message = null
     where id = v_run.id
     returning * into v_run;
    resumed := true;
  else
    resumed := false;
  end if;

  run_id := v_run.id; run_status := v_run.status;
  return next;
end;
$$;

revoke all on function public.resume_bluesky_campaign_run_after_recovery(uuid, uuid, date)
  from public, anon, authenticated;
grant execute on function public.resume_bluesky_campaign_run_after_recovery(uuid, uuid, date)
  to service_role;
