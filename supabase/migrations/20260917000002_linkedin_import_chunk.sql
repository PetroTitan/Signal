-- LinkedIn Sales Workspace — atomic import chunk.
--
-- The importer parses a customer-provided file in the application,
-- normalises each URL, and hands PostgreSQL one chunk at a time. This
-- function applies a chunk and advances the job's cursor IN ONE
-- TRANSACTION, so a retry after a crash between "rows inserted" and
-- "cursor recorded" cannot count the same rows twice: a chunk whose
-- cursor the job has already passed is acknowledged and not re-applied.
--
-- The suppression check happens here, against the workspace list, at
-- the moment of insertion. A suppressed profile is still recorded (so
-- the operator can see it was in the file) but as do_not_contact, and
-- nothing downstream ever prepares a task for it.
--
-- Nothing here contacts LinkedIn. The rows are what the customer gave.

create or replace function public.linkedin_apply_import_chunk(
  p_workspace_id uuid,
  p_job_id uuid,
  p_rows jsonb,
  p_next_cursor_row integer,
  p_invalid integer,
  p_errors jsonb,
  p_done boolean,
  p_processing_basis_note text default null,
  p_retention_until date default null
)
returns table (
  applied boolean,
  inserted integer,
  duplicates integer,
  suppressed integer,
  job_status text,
  next_cursor_row integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.linkedin_import_jobs%rowtype;
  v_inserted integer := 0;
  v_suppressed integer := 0;
  v_duplicates integer := 0;
  v_total integer := 0;
  v_errors jsonb;
begin
  if not public.can_edit_linkedin_sales(p_workspace_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'chunk too large' using errcode = '22023';
  end if;
  if p_errors is not null and jsonb_typeof(p_errors) <> 'array' then
    raise exception 'errors must be a JSON array' using errcode = '22023';
  end if;
  if p_next_cursor_row is null or p_next_cursor_row < 0 then
    raise exception 'cursor must be a non-negative row index' using errcode = '22023';
  end if;

  select * into v_job
    from public.linkedin_import_jobs
   where workspace_id = p_workspace_id and id = p_job_id
     for update;
  if not found then
    raise exception 'import job not found' using errcode = 'P0002';
  end if;

  -- Idempotency: already past this cursor, or already finished.
  if v_job.status = 'ready' or v_job.cursor_row >= p_next_cursor_row then
    return query
      select false, v_job.inserted_count, v_job.duplicate_count, v_job.suppressed_count,
             v_job.status, v_job.cursor_row;
    return;
  end if;

  v_total := jsonb_array_length(p_rows);

  with candidates as (
    select
      r->>'profile_key' as profile_key,
      r->>'canonical_profile_url' as canonical_profile_url,
      nullif(left(r->>'name', 200), '') as name,
      nullif(left(r->>'company', 200), '') as company,
      nullif(left(r->>'title', 200), '') as title
      from jsonb_array_elements(p_rows) r
  ), ins as (
    insert into public.linkedin_leads (
      workspace_id, lead_list_id, profile_key, canonical_profile_url,
      customer_provided_name, customer_provided_company, customer_provided_title,
      source_type, source_reference, processing_basis_note, retention_until,
      do_not_contact, do_not_contact_reason
    )
    select
      p_workspace_id, v_job.lead_list_id, c.profile_key, c.canonical_profile_url,
      c.name, c.company, c.title,
      v_job.source_type,
      left(coalesce(v_job.file_name, 'import ' || v_job.id::text), 300),
      nullif(left(p_processing_basis_note, 1000), ''),
      p_retention_until,
      (s.profile_key is not null),
      case when s.profile_key is not null then 'suppression_list' end
      from candidates c
      left join public.linkedin_suppression_entries s
        on s.workspace_id = p_workspace_id and s.profile_key = c.profile_key
    on conflict (workspace_id, lead_list_id, profile_key) do nothing
    returning do_not_contact
  )
  select count(*) filter (where not do_not_contact),
         count(*) filter (where do_not_contact)
    into v_inserted, v_suppressed
    from ins;

  v_duplicates := v_total - v_inserted - v_suppressed;

  v_errors := coalesce(v_job.error_report, '[]'::jsonb) || coalesce(p_errors, '[]'::jsonb);
  if jsonb_array_length(v_errors) > 2000 then
    select coalesce(jsonb_agg(e order by ord), '[]'::jsonb)
      into v_errors
      from (
        select e, ord
          from jsonb_array_elements(v_errors) with ordinality as t(e, ord)
         order by ord
         limit 2000
      ) capped;
  end if;

  update public.linkedin_import_jobs
     set cursor_row = p_next_cursor_row,
         inserted_count = inserted_count + v_inserted,
         duplicate_count = duplicate_count + v_duplicates,
         invalid_count = invalid_count + greatest(coalesce(p_invalid, 0), 0),
         suppressed_count = suppressed_count + v_suppressed,
         error_report = v_errors,
         status = case when p_done then 'ready' else 'running' end,
         last_error = null
   where workspace_id = p_workspace_id and id = p_job_id
   returning * into v_job;

  if p_done then
    insert into public.linkedin_compliance_events
      (workspace_id, event_type, actor_user_id, entity_type, entity_id, details)
    values (
      p_workspace_id, 'import', auth.uid(), 'linkedin_import_job', p_job_id,
      jsonb_build_object(
        'lead_list_id', v_job.lead_list_id,
        'source_type', v_job.source_type,
        'inserted', v_job.inserted_count,
        'duplicates', v_job.duplicate_count,
        'invalid', v_job.invalid_count,
        'suppressed', v_job.suppressed_count
      )
    );
  end if;

  return query
    select true, v_job.inserted_count, v_job.duplicate_count, v_job.suppressed_count,
           v_job.status, v_job.cursor_row;
end;
$$;

revoke all on function public.linkedin_apply_import_chunk(uuid, uuid, jsonb, integer, integer, jsonb, boolean, text, date) from public;
grant execute on function public.linkedin_apply_import_chunk(uuid, uuid, jsonb, integer, integer, jsonb, boolean, text, date) to authenticated;

-- Mark a job failed without touching its counters. The next attempt
-- with the same file resumes from cursor_row.
create or replace function public.linkedin_fail_import_job(
  p_workspace_id uuid,
  p_job_id uuid,
  p_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_edit_linkedin_sales(p_workspace_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.linkedin_import_jobs
     set status = 'failed',
         last_error = left(coalesce(p_message, 'unknown'), 1000)
   where workspace_id = p_workspace_id and id = p_job_id
     and status <> 'ready';
end;
$$;

revoke all on function public.linkedin_fail_import_job(uuid, uuid, text) from public;
grant execute on function public.linkedin_fail_import_job(uuid, uuid, text) to authenticated;
