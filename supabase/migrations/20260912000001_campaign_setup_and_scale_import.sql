-- =====================================================================
-- Bluesky follow campaigns — the full quota set, and imports that finish
-- =====================================================================
--
-- Forward-only. 20260911000003, ...004, ...005 and ...006 are deployed
-- artifacts and are not touched. Everything here is additive and
-- idempotent.
--
-- TWO PROBLEMS.
--
-- 1. THE QUOTA SET HAD HOLES.
--
--    `check (requested_daily_quota in (100, 200, 400, 600, 800, 1000))`
--    skips 300, 500, 700 and 900. An operator who wants 300 follows a
--    day has to pick 200 or 400. The ceiling is not the problem — 1,000
--    stays — the gaps are.
--
-- 2. AN IMPORT LARGER THAN ~10,000 COULD NEVER FINISH.
--
--    The candidate import walked pages with OFFSET and stopped after 20
--    pages of 500. Continuing meant passing `start_page` back in, and
--    the only thing that knew the number was the browser — which never
--    sent it. Every invocation therefore restarted at page 1, so a
--    corpus beyond 10,000 was permanently stuck: the same first 10,000
--    rows re-imported for ever and the rest never reached.
--
--    OFFSET is the wrong tool regardless. It is O(offset) per page, and
--    it is not stable while rows are being written: a candidate
--    discovered mid-import shifts every later page, so rows are skipped
--    and re-read at random.
--
--    Progress now lives in the DATABASE, as a keyset checkpoint on a
--    job row. The browser supplies nothing, a refresh loses nothing, and
--    a crash resumes from the last committed window.

-- =====================================================================
-- 1. Every 100 from 100 to 1,000
-- =====================================================================
--
-- The ceiling is unchanged. Bluesky's documented budget is 35,000
-- points/day and a CREATE costs 3, so 1,000 follows/day is ~8.6% of it
-- — deliberate headroom, and not something this migration widens.

do $$
declare
  v_name text;
begin
  -- Drop whatever the inline CHECK was named, then add a named one so
  -- this is re-runnable and the next migration has something to target.
  for v_name in
    select conname
      from pg_constraint
     where conrelid = 'public.bluesky_follow_campaigns'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%requested_daily_quota%'
  loop
    execute format(
      'alter table public.bluesky_follow_campaigns drop constraint %I', v_name);
  end loop;

  alter table public.bluesky_follow_campaigns
    add constraint bluesky_follow_campaigns_requested_daily_quota_check
    check (requested_daily_quota in
      (100, 200, 300, 400, 500, 600, 700, 800, 900, 1000));
end;
$$;

comment on column public.bluesky_follow_campaigns.requested_daily_quota is
  'What the operator asked for: every 100 from 100 to 1,000. A closed '
  'set, not a range, so the UI and the database cannot disagree. What '
  'actually runs is effective_daily_quota, which is never higher.';

-- =====================================================================
-- 2. Reading candidates by KEYSET, never by offset
-- =====================================================================
--
-- The total order is (last_discovered_at desc, subject_did asc).
-- `subject_did` is the tie-breaker and it is unique within
-- (workspace, identity), so the order is total: no row can be skipped
-- or seen twice because two rows shared a timestamp.

create index if not exists bluesky_candidates_keyset_idx
  on public.bluesky_candidates
     (workspace_id, operator_account_id, last_discovered_at desc, subject_did asc);

-- Walking one target's followers needs the join in the same order.
create index if not exists bluesky_candidate_sources_target_idx
  on public.bluesky_candidate_sources (target_profile_id, candidate_id);

create or replace function public.list_bluesky_candidates_keyset(
  p_workspace_id uuid,
  p_operator_account_id uuid,
  p_states text[],
  p_target_profile_id uuid,
  -- TEXT, not timestamptz.
  --
  -- The cursor makes a round trip through the application on every
  -- window, and a driver that maps timestamptz to a millisecond-
  -- precision date type silently truncates it. Truncation moves the
  -- cursor BACKWARDS by up to a millisecond, and every row sharing that
  -- millisecond is then skipped — a measured walk lost 235 rows out of
  -- 5,000 that way. Text is exact in both directions.
  p_after_last_discovered_at text,
  p_after_subject_did text,
  p_limit integer
)
returns table (
  subject_did text,
  handle text,
  display_name text,
  last_discovered_at text,
  protected boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select c.subject_did, c.handle, c.display_name,
         c.last_discovered_at::text, c.protected
    from public.bluesky_candidates c
   where c.workspace_id = p_workspace_id
     and c.operator_account_id = p_operator_account_id
     and (p_states is null or c.relationship_state = any(p_states))
     -- Scoping to ONE target is what keeps unrelated imported lists
     -- from being silently mixed into the same queue.
     and (
       p_target_profile_id is null
       or exists (
         select 1
           from public.bluesky_candidate_sources s
          where s.candidate_id = c.id
            and s.target_profile_id = p_target_profile_id
       )
     )
     -- The keyset predicate, matching the ORDER BY exactly.
     and (
       p_after_last_discovered_at is null
       or c.last_discovered_at < p_after_last_discovered_at::timestamptz
       or (c.last_discovered_at = p_after_last_discovered_at::timestamptz
           and c.subject_did > p_after_subject_did)
     )
   order by c.last_discovered_at desc, c.subject_did asc
   limit least(greatest(coalesce(p_limit, 500), 1), 1000);
$$;

revoke all on function public.list_bluesky_candidates_keyset(
  uuid, uuid, text[], uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.list_bluesky_candidates_keyset(
  uuid, uuid, text[], uuid, text, text, integer)
  to service_role;

-- Counting the eligible corpus without reading it. The setup screen
-- shows an exact number for a 100,000-row source, so it must not be a
-- length().
create or replace function public.count_bluesky_candidates_eligible(
  p_workspace_id uuid,
  p_operator_account_id uuid,
  p_states text[],
  p_target_profile_id uuid
)
returns table (eligible integer, protected_excluded integer)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*) filter (where not c.protected)::int,
    count(*) filter (where c.protected)::int
    from public.bluesky_candidates c
   where c.workspace_id = p_workspace_id
     and c.operator_account_id = p_operator_account_id
     and (p_states is null or c.relationship_state = any(p_states))
     and (
       p_target_profile_id is null
       or exists (
         select 1
           from public.bluesky_candidate_sources s
          where s.candidate_id = c.id
            and s.target_profile_id = p_target_profile_id
       )
     );
$$;

revoke all on function public.count_bluesky_candidates_eligible(
  uuid, uuid, text[], uuid)
  from public, anon, authenticated;
grant execute on function public.count_bluesky_candidates_eligible(
  uuid, uuid, text[], uuid)
  to service_role;

-- =====================================================================
-- 3. Import progress, kept by the database
-- =====================================================================
--
-- One job per campaign. It records WHERE the walk got to and WHAT the
-- source was, so a second invocation continues instead of starting
-- again, and so a campaign cannot be built from two unrelated lists.

create table if not exists public.bluesky_campaign_import_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null,

  source_kind text not null
    check (source_kind in ('candidates', 'target_followers')),
  -- Set for BOTH kinds when the operator picked one list: for
  -- 'candidates' it narrows the corpus, for 'target_followers' it names
  -- the account whose followers are being walked.
  target_profile_id uuid,

  status text not null default 'running'
    check (status in ('running', 'ready', 'failed')),

  -- Keyset checkpoint for the candidate corpus. Matches the total order
  -- (last_discovered_at desc, subject_did asc).
  cursor_last_discovered_at timestamptz,
  cursor_subject_did text,

  -- The provider's own cursor, for a direct follower walk that spans
  -- invocations. Persisted for the same reason as the keyset: the
  -- browser is not a durable place to keep it.
  provider_cursor text,

  -- True only when the source said it had no more to give. A short page
  -- is NOT the end of a follower list.
  source_exhausted boolean not null default false,

  imported_count integer not null default 0,
  duplicate_count integer not null default 0,
  excluded_count integer not null default 0,
  pages_read integer not null default 0,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One queue per campaign. This is also what stops two unrelated
  -- sources being merged into one campaign by accident.
  unique (campaign_id)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'bluesky_campaign_import_jobs_campaign_tenant_fk'
  ) then
    alter table public.bluesky_campaign_import_jobs
      add constraint bluesky_campaign_import_jobs_campaign_tenant_fk
      foreign key (campaign_id, workspace_id)
      references public.bluesky_follow_campaigns (id, workspace_id)
      on delete cascade;
  end if;
end;
$$;

create index if not exists bluesky_campaign_import_jobs_ws_idx
  on public.bluesky_campaign_import_jobs (workspace_id, status);

alter table public.bluesky_campaign_import_jobs enable row level security;

drop policy if exists bluesky_campaign_import_jobs_select
  on public.bluesky_campaign_import_jobs;
create policy bluesky_campaign_import_jobs_select
  on public.bluesky_campaign_import_jobs
  for select
  using (public.is_workspace_member(workspace_id));

grant select, insert, update, delete
  on public.bluesky_campaign_import_jobs to service_role;

drop trigger if exists bluesky_campaign_import_jobs_touch
  on public.bluesky_campaign_import_jobs;
create trigger bluesky_campaign_import_jobs_touch
  before update on public.bluesky_campaign_import_jobs
  for each row execute function public.touch_updated_at();

-- Open or resume the job for a campaign.
--
-- Refuses to change the source of an existing job: a queue half-built
-- from one list and half from another is not something an operator can
-- reason about, and the campaign's whole promise is "these profiles".
create or replace function public.begin_bluesky_campaign_import(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_source_kind text,
  p_target_profile_id uuid
)
-- OUT names are prefixed because plpgsql cannot tell a parameter from
-- a column of the same name inside an UPDATE, and rejects the statement
-- as ambiguous only when the function is CALLED.
returns table (
  out_job_id uuid,
  out_status text,
  out_source_kind text,
  out_target_profile_id uuid,
  out_cursor_at text,
  out_cursor_did text,
  out_provider_cursor text,
  out_source_exhausted boolean,
  out_imported integer,
  out_duplicates integer,
  out_excluded integer,
  out_refused_reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.bluesky_campaign_import_jobs;
begin
  select * into v_job
    from public.bluesky_campaign_import_jobs
   where campaign_id = p_campaign_id
     for update;

  if v_job.id is null then
    insert into public.bluesky_campaign_import_jobs (
      workspace_id, campaign_id, source_kind, target_profile_id
    )
    values (p_workspace_id, p_campaign_id, p_source_kind, p_target_profile_id)
    returning * into v_job;
  elsif v_job.workspace_id <> p_workspace_id then
    out_refused_reason := 'workspace_mismatch';
    return next; return;
  elsif v_job.source_kind <> p_source_kind
     or v_job.target_profile_id is distinct from p_target_profile_id then
    out_refused_reason := 'source_mismatch';
    out_job_id := v_job.id;
    out_source_kind := v_job.source_kind;
    out_target_profile_id := v_job.target_profile_id;
    return next; return;
  elsif v_job.status = 'failed' then
    -- A retry resumes from the checkpoint rather than starting over.
    update public.bluesky_campaign_import_jobs
       set status = 'running', last_error = null
     where id = v_job.id
     returning * into v_job;
  end if;

  out_job_id := v_job.id;
  out_status := v_job.status;
  out_source_kind := v_job.source_kind;
  out_target_profile_id := v_job.target_profile_id;
  out_cursor_at := v_job.cursor_last_discovered_at::text;
  out_cursor_did := v_job.cursor_subject_did;
  out_provider_cursor := v_job.provider_cursor;
  out_source_exhausted := v_job.source_exhausted;
  out_imported := v_job.imported_count;
  out_duplicates := v_job.duplicate_count;
  out_excluded := v_job.excluded_count;
  out_refused_reason := null;
  return next;
end;
$$;

revoke all on function public.begin_bluesky_campaign_import(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.begin_bluesky_campaign_import(uuid, uuid, text, uuid)
  to service_role;

-- Commit one window of progress.
--
-- The cursor only ever moves FORWARD in the scan order. Two callers
-- that read the same checkpoint do the same work — harmless, because
-- `unique (campaign_id, subject_did)` is what actually deduplicates —
-- and the slower one's attempt to rewind the cursor is ignored. So a
-- repeated, retried or concurrent import can duplicate effort but can
-- never duplicate a member or skip one.
create or replace function public.advance_bluesky_campaign_import(
  p_workspace_id uuid,
  p_job_id uuid,
  p_cursor_last_discovered_at text,
  p_cursor_subject_did text,
  p_provider_cursor text,
  p_inserted integer,
  p_duplicates integer,
  p_excluded integer,
  p_pages integer,
  p_source_exhausted boolean,
  p_error text
)
returns table (
  out_status text,
  out_cursor_at text,
  out_cursor_did text,
  out_provider_cursor text,
  out_source_exhausted boolean,
  out_imported integer,
  out_duplicates integer,
  out_excluded integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.bluesky_campaign_import_jobs;
  v_advance boolean;
begin
  select * into v_job
    from public.bluesky_campaign_import_jobs
   where id = p_job_id
     and workspace_id = p_workspace_id
     for update;

  if v_job.id is null then
    return;
  end if;

  -- Monotonic guard. In the scan order (last_discovered_at DESC,
  -- subject_did ASC), "further along" means an older timestamp, or the
  -- same timestamp and a larger DID.
  v_advance :=
    p_cursor_last_discovered_at is not null
    and (
      v_job.cursor_last_discovered_at is null
      or p_cursor_last_discovered_at::timestamptz
           < v_job.cursor_last_discovered_at
      or (p_cursor_last_discovered_at::timestamptz
            = v_job.cursor_last_discovered_at
          and p_cursor_subject_did > v_job.cursor_subject_did)
    );

  update public.bluesky_campaign_import_jobs
     set cursor_last_discovered_at =
           case when v_advance then p_cursor_last_discovered_at::timestamptz
                else bluesky_campaign_import_jobs.cursor_last_discovered_at end,
         cursor_subject_did =
           case when v_advance then p_cursor_subject_did
                else bluesky_campaign_import_jobs.cursor_subject_did end,
         -- The provider's cursor is opaque and cannot be compared, so
         -- it is taken whenever one was supplied.
         provider_cursor = coalesce(p_provider_cursor, provider_cursor),
         imported_count = imported_count + greatest(coalesce(p_inserted, 0), 0),
         duplicate_count = duplicate_count + greatest(coalesce(p_duplicates, 0), 0),
         excluded_count = excluded_count + greatest(coalesce(p_excluded, 0), 0),
         pages_read = pages_read + greatest(coalesce(p_pages, 0), 0),
         source_exhausted = bluesky_campaign_import_jobs.source_exhausted
           or coalesce(p_source_exhausted, false),
         last_error = p_error,
         status = case
           when p_error is not null then 'failed'
           when bluesky_campaign_import_jobs.source_exhausted
             or coalesce(p_source_exhausted, false) then 'ready'
           else 'running'
         end
   where id = p_job_id
   returning * into v_job;

  out_status := v_job.status;
  out_cursor_at := v_job.cursor_last_discovered_at::text;
  out_cursor_did := v_job.cursor_subject_did;
  out_provider_cursor := v_job.provider_cursor;
  out_source_exhausted := v_job.source_exhausted;
  out_imported := v_job.imported_count;
  out_duplicates := v_job.duplicate_count;
  out_excluded := v_job.excluded_count;
  return next;
end;
$$;

revoke all on function public.advance_bluesky_campaign_import(
  uuid, uuid, text, text, text, integer, integer, integer, integer,
  boolean, text)
  from public, anon, authenticated;
grant execute on function public.advance_bluesky_campaign_import(
  uuid, uuid, text, text, text, integer, integer, integer, integer,
  boolean, text)
  to service_role;
