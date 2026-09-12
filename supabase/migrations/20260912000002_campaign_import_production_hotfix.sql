-- =====================================================================
-- Bluesky campaign import — production hotfix
-- =====================================================================
--
-- Forward-only. The merged 20260912000001 migration is intentionally
-- untouched.
--
-- This repairs two correctness boundaries:
--
--   1. last_discovered_at changes whenever a candidate is seen again,
--      so it cannot be a durable keyset cursor. The repaired walk uses
--      immutable first_discovered_at and a per-job snapshot boundary.
--   2. selecting max(import_sequence) in the application and inserting
--      later lets two importers allocate the same range. Sequence
--      allocation and insertion now happen in one database transaction
--      while the campaign row is locked.

alter table public.bluesky_campaign_import_jobs
  add column if not exists snapshot_at timestamptz,
  add column if not exists cursor_first_discovered_at timestamptz;

update public.bluesky_campaign_import_jobs
   set snapshot_at = coalesce(snapshot_at, now());

alter table public.bluesky_campaign_import_jobs
  alter column snapshot_at set default now(),
  alter column snapshot_at set not null;

-- A job which was declared ready using the mutable cursor must be
-- walked once more under the corrected order. Existing queue members
-- remain untouched and the campaign/DID unique key makes the replay
-- harmless.
update public.bluesky_campaign_import_jobs
   set cursor_first_discovered_at = null,
       cursor_subject_did = null,
       source_exhausted = false,
       status = 'running',
       last_error = null
 where source_kind = 'candidates'
   and cursor_first_discovered_at is null;

comment on column public.bluesky_campaign_import_jobs.snapshot_at is
  'Database time captured for one finite candidate snapshot. Candidates first discovered after this instant belong to a later campaign/import.';

comment on column public.bluesky_campaign_import_jobs.cursor_first_discovered_at is
  'Immutable keyset cursor paired with cursor_subject_did. Never use mutable last_discovered_at as durable progress.';

create index if not exists bluesky_candidates_import_snapshot_idx
  on public.bluesky_candidates
     (workspace_id, operator_account_id, first_discovered_at asc, subject_did asc);

-- A finite, stable window from the candidate snapshot. TEXT preserves
-- PostgreSQL timestamp precision across the PostgREST round trip.
create or replace function public.list_bluesky_candidates_snapshot_keyset(
  p_workspace_id uuid,
  p_operator_account_id uuid,
  p_states text[],
  p_target_profile_id uuid,
  p_snapshot_at text,
  p_after_first_discovered_at text,
  p_after_subject_did text,
  p_limit integer
)
returns table (
  subject_did text,
  handle text,
  display_name text,
  first_discovered_at text,
  protected boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select c.subject_did, c.handle, c.display_name,
         c.first_discovered_at::text, c.protected
    from public.bluesky_candidates c
   where c.workspace_id = p_workspace_id
     and c.operator_account_id = p_operator_account_id
     and c.first_discovered_at <= p_snapshot_at::timestamptz
     and (p_states is null or c.relationship_state = any(p_states))
     and (
       p_target_profile_id is null
       or exists (
         select 1
           from public.bluesky_candidate_sources s
          where s.candidate_id = c.id
            and s.target_profile_id = p_target_profile_id
            and s.first_seen_at <= p_snapshot_at::timestamptz
       )
     )
     and (
       p_after_first_discovered_at is null
       or c.first_discovered_at > p_after_first_discovered_at::timestamptz
       or (c.first_discovered_at = p_after_first_discovered_at::timestamptz
           and c.subject_did > p_after_subject_did)
     )
   order by c.first_discovered_at asc, c.subject_did asc
   limit least(greatest(coalesce(p_limit, 500), 1), 1000);
$$;

revoke all on function public.list_bluesky_candidates_snapshot_keyset(
  uuid, uuid, text[], uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.list_bluesky_candidates_snapshot_keyset(
  uuid, uuid, text[], uuid, text, text, text, integer)
  to service_role;

-- Commit progress in the repaired cursor space. This is a new function
-- rather than a changed return type/signature on a deployed RPC.
create or replace function public.advance_bluesky_campaign_import_v2(
  p_workspace_id uuid,
  p_job_id uuid,
  p_cursor_first_discovered_at text,
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
    from public.bluesky_campaign_import_jobs j
   where j.id = p_job_id
     and j.workspace_id = p_workspace_id
     for update;

  if v_job.id is null then return; end if;

  v_advance :=
    p_cursor_first_discovered_at is not null
    and (
      v_job.cursor_first_discovered_at is null
      or p_cursor_first_discovered_at::timestamptz
           > v_job.cursor_first_discovered_at
      or (p_cursor_first_discovered_at::timestamptz
            = v_job.cursor_first_discovered_at
          and p_cursor_subject_did > v_job.cursor_subject_did)
    );

  update public.bluesky_campaign_import_jobs j
     set cursor_first_discovered_at =
           case when v_advance then p_cursor_first_discovered_at::timestamptz
                else j.cursor_first_discovered_at end,
         cursor_subject_did =
           case when v_advance then p_cursor_subject_did
                else j.cursor_subject_did end,
         provider_cursor = case
           when p_source_exhausted then null
           when p_provider_cursor is not null then p_provider_cursor
           else j.provider_cursor
         end,
         imported_count = j.imported_count + greatest(coalesce(p_inserted, 0), 0),
         duplicate_count = j.duplicate_count + greatest(coalesce(p_duplicates, 0), 0),
         excluded_count = j.excluded_count + greatest(coalesce(p_excluded, 0), 0),
         pages_read = j.pages_read + greatest(coalesce(p_pages, 0), 0),
         source_exhausted = j.source_exhausted
           or coalesce(p_source_exhausted, false),
         last_error = p_error,
         status = case
           when p_error is not null then 'failed'
           when j.source_exhausted or coalesce(p_source_exhausted, false)
             then 'ready'
           else 'running'
         end
   where j.id = p_job_id
   returning * into v_job;

  out_status := v_job.status;
  out_cursor_at := v_job.cursor_first_discovered_at::text;
  out_cursor_did := v_job.cursor_subject_did;
  out_provider_cursor := v_job.provider_cursor;
  out_source_exhausted := v_job.source_exhausted;
  out_imported := v_job.imported_count;
  out_duplicates := v_job.duplicate_count;
  out_excluded := v_job.excluded_count;
  return next;
end;
$$;

revoke all on function public.advance_bluesky_campaign_import_v2(
  uuid, uuid, text, text, text, integer, integer, integer, integer,
  boolean, text)
  from public, anon, authenticated;
grant execute on function public.advance_bluesky_campaign_import_v2(
  uuid, uuid, text, text, text, integer, integer, integer, integer,
  boolean, text)
  to service_role;

-- Allocate queue positions and insert a bounded chunk atomically.
-- Locking the campaign (not merely the import job) also serializes old
-- and new import entry points which feed the same queue.
create or replace function public.import_bluesky_campaign_member_chunk(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_members jsonb
)
returns table (
  out_inserted integer,
  out_duplicates integer,
  out_last_sequence bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign_id uuid;
  v_start bigint;
  v_valid integer;
  v_inserted integer;
begin
  select c.id into v_campaign_id
    from public.bluesky_follow_campaigns c
   where c.id = p_campaign_id
     and c.workspace_id = p_workspace_id
   for update;

  if v_campaign_id is null then return; end if;

  select coalesce(max(m.import_sequence), 0)
    into v_start
    from public.bluesky_follow_campaign_members m
   where m.campaign_id = p_campaign_id;

  with parsed as materialized (
    select distinct on (x.subject_did)
           x.subject_did,
           x.current_handle,
           x.display_name,
           x.target_profile_id,
           coalesce(nullif(x.source_label, ''), 'import') as source_label
      from jsonb_to_recordset(coalesce(p_members, '[]'::jsonb)) as x(
        subject_did text,
        current_handle text,
        display_name text,
        target_profile_id uuid,
        source_label text
      )
     where x.subject_did like 'did:%'
     order by x.subject_did
  ), numbered as (
    select p.*,
           v_start + row_number() over (order by p.subject_did) as seq
      from parsed p
  ), inserted as (
    insert into public.bluesky_follow_campaign_members (
      workspace_id, campaign_id, subject_did, current_handle,
      display_name, import_sequence, status
    )
    select p_workspace_id, p_campaign_id, n.subject_did,
           n.current_handle, n.display_name, n.seq, 'queued'
      from numbered n
    on conflict (campaign_id, subject_did) do nothing
    returning id
  )
  select (select count(*) from parsed)::int,
         (select count(*) from inserted)::int
    into v_valid, v_inserted;

  -- Attribution is attached to both newly inserted and already-present
  -- members. ON CONFLICT without a target is deliberately compatible
  -- with the deployed unique constraint.
  with parsed as materialized (
    select distinct on (x.subject_did)
           x.subject_did,
           x.target_profile_id,
           coalesce(nullif(x.source_label, ''), 'import') as source_label
      from jsonb_to_recordset(coalesce(p_members, '[]'::jsonb)) as x(
        subject_did text,
        target_profile_id uuid,
        source_label text
      )
     where x.subject_did like 'did:%'
     order by x.subject_did
  )
  insert into public.bluesky_campaign_member_sources (
    workspace_id, member_id, target_profile_id, source_label
  )
  select p_workspace_id, m.id, p.target_profile_id, p.source_label
    from parsed p
    join public.bluesky_follow_campaign_members m
      on m.campaign_id = p_campaign_id
     and m.subject_did = p.subject_did
  on conflict do nothing;

  out_inserted := coalesce(v_inserted, 0);
  out_duplicates := greatest(coalesce(v_valid, 0) - out_inserted, 0);
  select coalesce(max(m.import_sequence), 0)
    into out_last_sequence
    from public.bluesky_follow_campaign_members m
   where m.campaign_id = p_campaign_id;
  return next;
end;
$$;

revoke all on function public.import_bluesky_campaign_member_chunk(
  uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.import_bluesky_campaign_member_chunk(
  uuid, uuid, jsonb)
  to service_role;
