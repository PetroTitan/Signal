-- =====================================================================
-- LinkedIn Sales Workspace — schema, RLS, and the functions that move it
-- =====================================================================
--
-- WHAT THIS IS
-- ------------
-- A compliance-first workspace for MANUAL LinkedIn outreach. Signal
-- stores customer-provided profile URLs, prepares and schedules manual
-- tasks for a human, and records what the human says they did. Nothing
-- here calls LinkedIn, reads LinkedIn, or holds anything that could log
-- in as a member. See docs/linkedin-sales/00-audit-and-boundary.md.
--
-- TENANT INTEGRITY, IN THE DATABASE
-- ---------------------------------
-- Every table carries workspace_id and a unique (workspace_id, id).
-- Every child references its parent with a COMPOSITE foreign key
-- (workspace_id, parent_id), so a row cannot reference a parent in
-- another workspace whatever the application does. RLS is on every
-- table; reads for members, writes for owner/admin/editor. Manual tasks
-- have NO insert policy for signed-in users: only the scheduler
-- function creates them, so a task can only come from a sequence step.
--
-- CLOSED SETS
-- -----------
-- Step kinds, task kinds, task states, member states, campaign states,
-- source types and compliance event types are CHECK-constrained. There
-- is deliberately no "automatic LinkedIn" kind of anything.
--
-- Forward-only. Idempotent where PostgreSQL allows it.

-- ---------------------------------------------------------------------
-- 0. Role helper — mirrors `edit_content` in core/teams/permissions.ts
-- ---------------------------------------------------------------------

create or replace function public.can_edit_linkedin_sales(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.workspace_members wm
     where wm.workspace_id = target
       and wm.user_id = auth.uid()
       and wm.role in ('owner', 'admin', 'editor')
  );
$$;
revoke all on function public.can_edit_linkedin_sales(uuid) from public;
grant execute on function public.can_edit_linkedin_sales(uuid)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

create table if not exists public.linkedin_lead_lists (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  -- Where the customer says these URLs came from. Mandatory.
  source_type text not null
    check (source_type in ('customer_csv', 'customer_pasted', 'internal_api')),
  source_note text check (source_note is null or length(source_note) <= 1000),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create index if not exists linkedin_lead_lists_workspace_idx
  on public.linkedin_lead_lists (workspace_id, created_at desc, id);

create table if not exists public.linkedin_leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_list_id uuid not null,
  -- The normalised public profile slug, lower-cased. The only key.
  profile_key text not null check (profile_key ~ '^[a-z0-9][a-z0-9._%-]{0,199}$'),
  canonical_profile_url text not null
    check (canonical_profile_url = 'https://www.linkedin.com/in/' || profile_key),
  -- Customer-provided, never fetched. Nothing else about the person.
  customer_provided_name text check (customer_provided_name is null or length(customer_provided_name) <= 200),
  customer_provided_company text check (customer_provided_company is null or length(customer_provided_company) <= 200),
  customer_provided_title text check (customer_provided_title is null or length(customer_provided_title) <= 200),
  source_type text not null
    check (source_type in ('customer_csv', 'customer_pasted', 'internal_api')),
  source_reference text check (source_reference is null or length(source_reference) <= 300),
  processing_basis_note text check (processing_basis_note is null or length(processing_basis_note) <= 1000),
  do_not_contact boolean not null default false,
  do_not_contact_reason text check (do_not_contact_reason is null or length(do_not_contact_reason) <= 500),
  retention_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, lead_list_id, profile_key),
  foreign key (workspace_id, lead_list_id)
    references public.linkedin_lead_lists (workspace_id, id) on delete cascade
);
-- Keyset over a list: (created_at, id) is total.
create index if not exists linkedin_leads_list_keyset_idx
  on public.linkedin_leads (workspace_id, lead_list_id, created_at, id);
create index if not exists linkedin_leads_profile_key_idx
  on public.linkedin_leads (workspace_id, profile_key);
create index if not exists linkedin_leads_retention_idx
  on public.linkedin_leads (workspace_id, retention_until)
  where retention_until is not null;

create table if not exists public.linkedin_suppression_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  profile_key text not null check (profile_key ~ '^[a-z0-9][a-z0-9._%-]{0,199}$'),
  canonical_profile_url text not null
    check (canonical_profile_url = 'https://www.linkedin.com/in/' || profile_key),
  reason text check (reason is null or length(reason) <= 500),
  source text not null
    check (source in ('operator', 'import', 'task', 'unsubscribe', 'deletion_request')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, profile_key)
);

create table if not exists public.linkedin_sequences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table if not exists public.linkedin_sequence_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  sequence_id uuid not null,
  position integer not null check (position >= 1 and position <= 50),
  -- CLOSED. Every kind is a manual task, a pause, a note, or an
  -- authorized email through a separately authorized integration.
  -- There is no automatic LinkedIn kind and there will not be one.
  kind text not null check (kind in (
    'manual_connection_request',
    'manual_linkedin_message',
    'manual_profile_review',
    'wait',
    'internal_note',
    'authorized_email'
  )),
  wait_days integer not null default 0 check (wait_days between 0 and 365),
  template text check (template is null or length(template) <= 4000),
  required_confirmation boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, sequence_id, position),
  foreign key (workspace_id, sequence_id)
    references public.linkedin_sequences (workspace_id, id) on delete cascade,
  check (kind <> 'wait' or template is null)
);

create table if not exists public.linkedin_campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_list_id uuid not null,
  sequence_id uuid not null,
  name text not null check (length(name) between 1 and 120),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'completed', 'cancelled')),
  timezone text not null default 'UTC' check (length(timezone) between 1 and 64),
  working_window_start_minute integer not null default 540
    check (working_window_start_minute between 0 and 1439),
  working_window_end_minute integer not null default 1200
    check (working_window_end_minute between 1 and 1440),
  -- How many manual tasks Signal PREPARES for people per local day.
  -- Not a LinkedIn limit of any kind.
  daily_task_target integer not null default 20
    check (daily_task_target between 1 and 200),
  membership_frozen_at timestamptz,
  last_dispatched_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  activated_at timestamptz,
  paused_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, lead_list_id)
    references public.linkedin_lead_lists (workspace_id, id) on delete restrict,
  foreign key (workspace_id, sequence_id)
    references public.linkedin_sequences (workspace_id, id) on delete restrict,
  check (working_window_end_minute > working_window_start_minute)
);
create index if not exists linkedin_campaigns_dispatch_idx
  on public.linkedin_campaigns (status, last_dispatched_at nulls first)
  where status = 'active';

create table if not exists public.linkedin_campaign_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null,
  lead_id uuid not null,
  -- CLOSED. Every member ends in exactly one explainable state.
  state text not null default 'waiting' check (state in (
    'waiting', 'completed', 'suppressed', 'operator_skipped',
    'structurally_invalid', 'cancelled'
  )),
  state_reason text check (state_reason is null or length(state_reason) <= 500),
  -- The step the member is on next (1-based). Advances on confirmation
  -- and through wait steps.
  current_position integer not null default 1 check (current_position >= 1),
  -- When the current step may be prepared. NULL while a task for the
  -- current step exists and awaits the operator.
  next_step_available_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, campaign_id, lead_id),
  foreign key (workspace_id, campaign_id)
    references public.linkedin_campaigns (workspace_id, id) on delete cascade,
  foreign key (workspace_id, lead_id)
    references public.linkedin_leads (workspace_id, id) on delete cascade,
  -- A terminal state other than completed always says why.
  check (state in ('waiting', 'completed') or state_reason is not null),
  check ((state = 'completed') = (completed_at is not null))
);
-- The release keyset: due members of a campaign in a total order.
create index if not exists linkedin_campaign_members_due_idx
  on public.linkedin_campaign_members (workspace_id, campaign_id, next_step_available_at, id)
  where state = 'waiting';
create index if not exists linkedin_campaign_members_state_idx
  on public.linkedin_campaign_members (workspace_id, campaign_id, state);

create table if not exists public.linkedin_manual_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null,
  campaign_member_id uuid not null,
  sequence_step_id uuid not null,
  -- CLOSED. Copied from the step by the release function; a wait never
  -- becomes a task.
  kind text not null check (kind in (
    'manual_connection_request',
    'manual_linkedin_message',
    'manual_profile_review',
    'internal_note',
    'authorized_email'
  )),
  -- CLOSED. opened and copied are recordings on the way; only
  -- operator_confirmed completes a task, and only a person sets it.
  state text not null default 'scheduled' check (state in (
    'scheduled', 'ready', 'opened', 'copied', 'operator_confirmed', 'skipped', 'cancelled'
  )),
  draft_text text check (draft_text is null or length(draft_text) <= 4000),
  profile_url text not null check (profile_url like 'https://www.linkedin.com/in/%'),
  local_date date not null,
  available_at timestamptz not null,
  opened_at timestamptz,
  copied_at timestamptz,
  operator_confirmed_at timestamptz,
  operator_confirmed_by uuid references auth.users(id) on delete set null,
  skip_reason text check (skip_reason is null or length(skip_reason) <= 500),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  -- One task per (member, step), ever. This is the scheduler's
  -- idempotency: a replayed tick inserts nothing.
  unique (workspace_id, campaign_member_id, sequence_step_id),
  foreign key (workspace_id, campaign_id)
    references public.linkedin_campaigns (workspace_id, id) on delete cascade,
  foreign key (workspace_id, campaign_member_id)
    references public.linkedin_campaign_members (workspace_id, id) on delete cascade,
  foreign key (workspace_id, sequence_step_id)
    references public.linkedin_sequence_steps (workspace_id, id) on delete restrict,
  -- The timestamps and the state agree, or the row is refused.
  check ((state = 'operator_confirmed') = (operator_confirmed_at is not null)),
  check (operator_confirmed_by is null or state = 'operator_confirmed'),
  check ((state = 'skipped') = (skip_reason is not null)),
  check ((state = 'cancelled') = (cancelled_at is not null)),
  check (opened_at is null or state in ('opened', 'copied', 'operator_confirmed', 'skipped', 'cancelled')),
  check (copied_at is null or state in ('copied', 'operator_confirmed', 'skipped', 'cancelled'))
);
-- One NON-TERMINAL task per member at a time.
create unique index if not exists linkedin_manual_tasks_one_active_idx
  on public.linkedin_manual_tasks (workspace_id, campaign_member_id)
  where state in ('scheduled', 'ready', 'opened', 'copied');
create index if not exists linkedin_manual_tasks_day_idx
  on public.linkedin_manual_tasks (workspace_id, campaign_id, local_date);
create index if not exists linkedin_manual_tasks_ready_idx
  on public.linkedin_manual_tasks (workspace_id, state, available_at, id);

create table if not exists public.linkedin_import_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_list_id uuid not null,
  status text not null default 'running' check (status in ('running', 'ready', 'failed')),
  source_type text not null
    check (source_type in ('customer_csv', 'customer_pasted', 'internal_api')),
  file_name text check (file_name is null or length(file_name) <= 300),
  -- SHA-256 of the exact bytes. The same file re-sent resumes this job
  -- from cursor_row instead of starting another.
  file_fingerprint text not null check (length(file_fingerprint) = 64),
  total_rows integer not null default 0 check (total_rows >= 0),
  cursor_row integer not null default 0 check (cursor_row >= 0),
  inserted_count integer not null default 0 check (inserted_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  invalid_count integer not null default 0 check (invalid_count >= 0),
  suppressed_count integer not null default 0 check (suppressed_count >= 0),
  -- Bounded: rows that could not be imported, with the reason. Never
  -- silently discarded; exportable.
  error_report jsonb not null default '[]'::jsonb
    check (jsonb_typeof(error_report) = 'array' and jsonb_array_length(error_report) <= 2000),
  last_error text check (last_error is null or length(last_error) <= 1000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, lead_list_id, file_fingerprint),
  foreign key (workspace_id, lead_list_id)
    references public.linkedin_lead_lists (workspace_id, id) on delete cascade
);

create table if not exists public.linkedin_compliance_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  event_type text not null check (event_type in (
    'import', 'suppression_added', 'suppression_removed', 'export', 'deletion',
    'operator_confirmation', 'task_skipped', 'task_opened', 'task_copied',
    'campaign_activated', 'campaign_paused', 'campaign_resumed', 'campaign_cancelled',
    'retention_purge'
  )),
  actor_user_id uuid references auth.users(id) on delete set null,
  entity_type text check (entity_type is null or length(entity_type) <= 64),
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create index if not exists linkedin_compliance_events_idx
  on public.linkedin_compliance_events (workspace_id, created_at desc, id);

-- ---------------------------------------------------------------------
-- 2. Triggers
-- ---------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'linkedin_lead_lists', 'linkedin_leads', 'linkedin_sequences',
    'linkedin_sequence_steps', 'linkedin_campaigns', 'linkedin_campaign_members',
    'linkedin_manual_tasks', 'linkedin_import_jobs'
  ] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format(
      'create trigger %I_touch before update on public.%I for each row execute function public.touch_updated_at()',
      t, t);
  end loop;
end;
$$;

-- Compliance events are append-only for EVERY role, service_role
-- included. A record of what happened is not something to tidy.
create or replace function public.linkedin_compliance_events_are_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'linkedin_compliance_events is append-only';
end;
$$;
drop trigger if exists linkedin_compliance_events_append_only
  on public.linkedin_compliance_events;
create trigger linkedin_compliance_events_append_only
  before update or delete on public.linkedin_compliance_events
  for each row execute function public.linkedin_compliance_events_are_append_only();

-- A task's kind is its step's kind. Enforced on every insert or update,
-- whoever writes.
create or replace function public.linkedin_task_kind_matches_step()
returns trigger
language plpgsql
as $$
declare
  v_kind text;
begin
  select s.kind into v_kind
    from public.linkedin_sequence_steps s
   where s.workspace_id = new.workspace_id and s.id = new.sequence_step_id;
  if v_kind is null then
    raise exception 'linkedin_manual_tasks.sequence_step_id does not name a step in this workspace';
  end if;
  if v_kind = 'wait' then
    raise exception 'a wait step never becomes a task';
  end if;
  if new.kind <> v_kind then
    raise exception 'linkedin_manual_tasks.kind (%) must equal the step kind (%)', new.kind, v_kind;
  end if;
  return new;
end;
$$;
drop trigger if exists linkedin_manual_tasks_kind_check on public.linkedin_manual_tasks;
create trigger linkedin_manual_tasks_kind_check
  before insert or update of kind, sequence_step_id on public.linkedin_manual_tasks
  for each row execute function public.linkedin_task_kind_matches_step();

-- ---------------------------------------------------------------------
-- 3. Row-level security
-- ---------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'linkedin_lead_lists', 'linkedin_leads', 'linkedin_suppression_entries',
    'linkedin_sequences', 'linkedin_sequence_steps', 'linkedin_campaigns',
    'linkedin_campaign_members', 'linkedin_manual_tasks', 'linkedin_import_jobs',
    'linkedin_compliance_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    -- Every member may read their workspace's rows.
    execute format('drop policy if exists %I on public.%I', t || ': members read', t);
    execute format(
      'create policy %I on public.%I for select using (public.is_workspace_member(workspace_id))',
      t || ': members read', t);
  end loop;

  -- Editors (owner/admin/editor) write lists, leads, suppression,
  -- sequences, steps, campaigns, members and import jobs.
  foreach t in array array[
    'linkedin_lead_lists', 'linkedin_leads', 'linkedin_suppression_entries',
    'linkedin_sequences', 'linkedin_sequence_steps', 'linkedin_campaigns',
    'linkedin_campaign_members', 'linkedin_import_jobs'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || ': editors insert', t);
    execute format(
      'create policy %I on public.%I for insert with check (public.can_edit_linkedin_sales(workspace_id))',
      t || ': editors insert', t);
    execute format('drop policy if exists %I on public.%I', t || ': editors update', t);
    execute format(
      'create policy %I on public.%I for update using (public.can_edit_linkedin_sales(workspace_id)) with check (public.can_edit_linkedin_sales(workspace_id))',
      t || ': editors update', t);
    execute format('drop policy if exists %I on public.%I', t || ': editors delete', t);
    execute format(
      'create policy %I on public.%I for delete using (public.can_edit_linkedin_sales(workspace_id))',
      t || ': editors delete', t);
  end loop;
end;
$$;

-- Manual tasks: members read; editors may update state (the guarded
-- transitions are in the functions below and the repository); NO
-- insert and NO delete policy for signed-in users. A task exists only
-- because the scheduler prepared it from a step.
drop policy if exists "linkedin_manual_tasks: editors update" on public.linkedin_manual_tasks;
create policy "linkedin_manual_tasks: editors update"
  on public.linkedin_manual_tasks for update
  using (public.can_edit_linkedin_sales(workspace_id))
  with check (public.can_edit_linkedin_sales(workspace_id));

-- Compliance events: members read, members insert, nobody updates or
-- deletes (no policy, and the trigger refuses regardless of policy).
drop policy if exists "linkedin_compliance_events: members insert" on public.linkedin_compliance_events;
create policy "linkedin_compliance_events: members insert"
  on public.linkedin_compliance_events for insert
  with check (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------
-- 4. Table privileges for the scheduler
-- ---------------------------------------------------------------------
--
-- service_role reads what the release function needs and writes ONLY
-- tasks, members and campaigns. It has no path to LinkedIn: there is no
-- client for it to call.

do $$
declare
  t text;
begin
  foreach t in array array[
    'linkedin_lead_lists', 'linkedin_leads', 'linkedin_suppression_entries',
    'linkedin_sequences', 'linkedin_sequence_steps', 'linkedin_import_jobs',
    'linkedin_compliance_events'
  ] loop
    execute format('grant select on public.%I to service_role', t);
  end loop;
  foreach t in array array[
    'linkedin_campaigns', 'linkedin_campaign_members', 'linkedin_manual_tasks'
  ] loop
    execute format('grant select, insert, update on public.%I to service_role', t);
  end loop;
  execute 'grant insert on public.linkedin_compliance_events to service_role';
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Functions
-- ---------------------------------------------------------------------

-- 5.1 Draft rendering. Customer-provided fields only; nothing inferred.
create or replace function public.linkedin_render_draft(
  p_template text,
  p_name text,
  p_company text,
  p_title text
)
returns text
language sql
immutable
as $$
  select case
    when p_template is null then null
    else replace(replace(replace(p_template,
      '{{name}}', coalesce(p_name, '')),
      '{{company}}', coalesce(p_company, '')),
      '{{title}}', coalesce(p_title, ''))
  end;
$$;

-- 5.2 Activate — FREEZES membership on the first activation.
--
-- Called by an editor (SECURITY DEFINER with the role check inside so
-- the whole freeze is one transaction). Refuses a sequence with no
-- steps, a list with no leads, or an authorized_email step while no
-- email integration is authorized in this release.
create or replace function public.activate_linkedin_campaign(
  p_workspace_id uuid,
  p_campaign_id uuid
)
returns table (
  ok boolean,
  refused_reason text,
  members_waiting integer,
  members_suppressed integer,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.linkedin_campaigns;
  v_steps integer;
  v_email_steps integer;
  v_leads integer;
  v_waiting integer := 0;
  v_suppressed integer := 0;
begin
  if not public.can_edit_linkedin_sales(p_workspace_id) then
    return query select false, 'forbidden'::text, 0, 0, null::text; return;
  end if;

  select * into v_campaign
    from public.linkedin_campaigns
   where workspace_id = p_workspace_id and id = p_campaign_id
   for update;
  if v_campaign.id is null then
    return query select false, 'not_found'::text, 0, 0, null::text; return;
  end if;
  if v_campaign.status not in ('draft', 'paused') then
    return query select false, 'not_activatable'::text, 0, 0, v_campaign.status; return;
  end if;

  select count(*), count(*) filter (where kind = 'authorized_email')
    into v_steps, v_email_steps
    from public.linkedin_sequence_steps
   where workspace_id = p_workspace_id and sequence_id = v_campaign.sequence_id;
  if v_steps = 0 then
    return query select false, 'sequence_has_no_steps'::text, 0, 0, v_campaign.status; return;
  end if;
  if v_email_steps > 0 then
    -- No email integration is authorized in this release. Fail closed.
    return query select false, 'email_integration_unavailable'::text, 0, 0, v_campaign.status; return;
  end if;

  if v_campaign.membership_frozen_at is null then
    select count(*) into v_leads
      from public.linkedin_leads
     where workspace_id = p_workspace_id and lead_list_id = v_campaign.lead_list_id;
    if v_leads = 0 then
      return query select false, 'list_has_no_leads'::text, 0, 0, v_campaign.status; return;
    end if;

    -- Freeze: one member per lead as the list stands NOW. A suppressed
    -- or do-not-contact lead is a member too — in the suppressed state,
    -- with the reason — so nothing is silently dropped.
    with inserted as (
      insert into public.linkedin_campaign_members
        (workspace_id, campaign_id, lead_id, state, state_reason, current_position, next_step_available_at)
      select l.workspace_id, p_campaign_id, l.id,
             case when l.do_not_contact or s.id is not null then 'suppressed' else 'waiting' end,
             case
               when l.do_not_contact then coalesce(l.do_not_contact_reason, 'do_not_contact')
               when s.id is not null then 'suppression_list'
               else null
             end,
             1,
             case when l.do_not_contact or s.id is not null then null else now() end
        from public.linkedin_leads l
        left join public.linkedin_suppression_entries s
          on s.workspace_id = l.workspace_id and s.profile_key = l.profile_key
       where l.workspace_id = p_workspace_id
         and l.lead_list_id = v_campaign.lead_list_id
      on conflict (workspace_id, campaign_id, lead_id) do nothing
      returning state
    )
    select count(*) filter (where state = 'waiting'),
           count(*) filter (where state = 'suppressed')
      into v_waiting, v_suppressed
      from inserted;

    update public.linkedin_campaigns
       set status = 'active', activated_at = now(), paused_at = null,
           membership_frozen_at = now()
     where workspace_id = p_workspace_id and id = p_campaign_id;
  else
    -- Resume: membership stays frozen; nothing is added.
    update public.linkedin_campaigns
       set status = 'active', paused_at = null
     where workspace_id = p_workspace_id and id = p_campaign_id;
  end if;

  insert into public.linkedin_compliance_events
    (workspace_id, event_type, actor_user_id, entity_type, entity_id, details)
  values (p_workspace_id,
          case when v_campaign.membership_frozen_at is null then 'campaign_activated' else 'campaign_resumed' end,
          auth.uid(), 'linkedin_campaign', p_campaign_id,
          jsonb_build_object('members_waiting', v_waiting, 'members_suppressed', v_suppressed));

  return query select true, null::text, v_waiting, v_suppressed, 'active'::text;
end;
$$;
revoke all on function public.activate_linkedin_campaign(uuid, uuid) from public;
grant execute on function public.activate_linkedin_campaign(uuid, uuid) to authenticated, service_role;

-- 5.3 Release — the scheduler's one write path. service_role only.
--
-- For ONE campaign and ONE local date: walks due waiting members in a
-- total keyset order, advances through wait steps, marks members whose
-- lead is now suppressed, and inserts up to p_limit tasks. The unique
-- (member, step) key makes a replay insert nothing. Everything happens
-- in this one transaction: a crash before commit leaves no partial
-- task; a crash after leaves nothing for a retry to do.
create or replace function public.release_linkedin_campaign_tasks(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_local_date date,
  p_now timestamptz,
  p_limit integer
)
returns table (
  released integer,
  waits_advanced integer,
  suppressed integer,
  invalid integer,
  completed_members integer,
  campaign_completed boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.linkedin_campaigns;
  v_member record;
  v_step record;
  v_lead record;
  v_released integer := 0;
  v_waits integer := 0;
  v_suppressed integer := 0;
  v_invalid integer := 0;
  v_completed integer := 0;
  v_inserted integer;
  v_open integer;
  v_done boolean := false;
begin
  select * into v_campaign
    from public.linkedin_campaigns
   where workspace_id = p_workspace_id and id = p_campaign_id
   for update;
  if v_campaign.id is null or v_campaign.status <> 'active' then
    return query select 0, 0, 0, 0, 0, false; return;
  end if;

  -- Promote what became due since the last pass.
  update public.linkedin_manual_tasks
     set state = 'ready'
   where workspace_id = p_workspace_id and campaign_id = p_campaign_id
     and state = 'scheduled' and available_at <= p_now;

  for v_member in
    select m.*
      from public.linkedin_campaign_members m
     where m.workspace_id = p_workspace_id
       and m.campaign_id = p_campaign_id
       and m.state = 'waiting'
       and m.next_step_available_at is not null
       and m.next_step_available_at <= p_now
     order by m.next_step_available_at, m.id
       for update skip locked
     limit greatest(p_limit, 1) * 4
  loop
    exit when v_released >= greatest(p_limit, 0);

    select l.* into v_lead
      from public.linkedin_leads l
     where l.workspace_id = p_workspace_id and l.id = v_member.lead_id;

    -- Suppression wins over everything, at every release.
    if v_lead.id is null or v_lead.do_not_contact
       or exists (select 1 from public.linkedin_suppression_entries s
                   where s.workspace_id = p_workspace_id and s.profile_key = v_lead.profile_key) then
      update public.linkedin_campaign_members
         set state = 'suppressed',
             state_reason = case when v_lead.id is null then 'lead_deleted'
                                 when v_lead.do_not_contact then coalesce(v_lead.do_not_contact_reason, 'do_not_contact')
                                 else 'suppression_list' end,
             next_step_available_at = null
       where id = v_member.id;
      v_suppressed := v_suppressed + 1;
      continue;
    end if;

    -- The step this member is on. Past the last step = completed.
    select s.* into v_step
      from public.linkedin_sequence_steps s
     where s.workspace_id = p_workspace_id
       and s.sequence_id = v_campaign.sequence_id
       and s.position = v_member.current_position;
    if v_step.id is null then
      if exists (select 1 from public.linkedin_sequence_steps s
                  where s.workspace_id = p_workspace_id and s.sequence_id = v_campaign.sequence_id
                    and s.position > v_member.current_position) then
        -- A gap in positions. Fail closed, visibly.
        update public.linkedin_campaign_members
           set state = 'structurally_invalid', state_reason = 'sequence_position_gap',
               next_step_available_at = null
         where id = v_member.id;
        v_invalid := v_invalid + 1;
      else
        update public.linkedin_campaign_members
           set state = 'completed', completed_at = p_now, next_step_available_at = null
         where id = v_member.id;
        v_completed := v_completed + 1;
      end if;
      continue;
    end if;

    if v_step.kind = 'wait' then
      update public.linkedin_campaign_members
         set current_position = v_member.current_position + 1,
             next_step_available_at = p_now + make_interval(days => v_step.wait_days)
       where id = v_member.id;
      v_waits := v_waits + 1;
      continue;
    end if;

    if v_step.kind = 'authorized_email' then
      -- Defence in depth: activation refuses this; a step edited in
      -- after activation still cannot produce a task.
      update public.linkedin_campaign_members
         set state = 'structurally_invalid', state_reason = 'email_integration_unavailable',
             next_step_available_at = null
       where id = v_member.id;
      v_invalid := v_invalid + 1;
      continue;
    end if;

    if v_step.kind not in ('manual_connection_request', 'manual_linkedin_message',
                           'manual_profile_review', 'internal_note') then
      -- Unknown to this scheduler: fail closed, never guess.
      update public.linkedin_campaign_members
         set state = 'structurally_invalid', state_reason = 'unknown_step_kind:' || v_step.kind,
             next_step_available_at = null
       where id = v_member.id;
      v_invalid := v_invalid + 1;
      continue;
    end if;

    insert into public.linkedin_manual_tasks
      (workspace_id, campaign_id, campaign_member_id, sequence_step_id, kind, state,
       draft_text, profile_url, local_date, available_at)
    values (p_workspace_id, p_campaign_id, v_member.id, v_step.id, v_step.kind,
            'ready',
            public.linkedin_render_draft(v_step.template, v_lead.customer_provided_name,
                                         v_lead.customer_provided_company, v_lead.customer_provided_title),
            v_lead.canonical_profile_url, p_local_date, p_now)
    on conflict (workspace_id, campaign_member_id, sequence_step_id) do nothing;
    get diagnostics v_inserted = row_count;

    -- The member now waits on the operator, not on the clock.
    update public.linkedin_campaign_members
       set next_step_available_at = null
     where id = v_member.id;

    if v_inserted > 0 then
      v_released := v_released + 1;
    end if;
  end loop;

  -- Nothing waiting and nothing open: the campaign is done.
  select count(*) into v_open
    from public.linkedin_manual_tasks
   where workspace_id = p_workspace_id and campaign_id = p_campaign_id
     and state in ('scheduled', 'ready', 'opened', 'copied');
  if v_open = 0 and not exists (
      select 1 from public.linkedin_campaign_members m
       where m.workspace_id = p_workspace_id and m.campaign_id = p_campaign_id and m.state = 'waiting') then
    update public.linkedin_campaigns
       set status = 'completed', completed_at = p_now
     where workspace_id = p_workspace_id and id = p_campaign_id and status = 'active';
    v_done := true;
  end if;

  return query select v_released, v_waits, v_suppressed, v_invalid, v_completed, v_done;
end;
$$;
revoke all on function public.release_linkedin_campaign_tasks(uuid, uuid, date, timestamptz, integer) from public;
grant execute on function public.release_linkedin_campaign_tasks(uuid, uuid, date, timestamptz, integer) to service_role;

-- 5.4 Operator confirmation — the ONLY way a task completes.
create or replace function public.confirm_linkedin_task(
  p_workspace_id uuid,
  p_task_id uuid
)
returns table (ok boolean, refused_reason text, member_state text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.linkedin_manual_tasks;
  v_member public.linkedin_campaign_members;
  v_campaign public.linkedin_campaigns;
  v_last integer;
begin
  if auth.uid() is null or not public.can_edit_linkedin_sales(p_workspace_id) then
    return query select false, 'forbidden'::text, null::text; return;
  end if;
  select * into v_task from public.linkedin_manual_tasks
   where workspace_id = p_workspace_id and id = p_task_id for update;
  if v_task.id is null then
    return query select false, 'not_found'::text, null::text; return;
  end if;
  if v_task.state not in ('ready', 'opened', 'copied') then
    return query select false, 'not_confirmable:' || v_task.state, null::text; return;
  end if;

  update public.linkedin_manual_tasks
     set state = 'operator_confirmed', operator_confirmed_at = now(), operator_confirmed_by = auth.uid()
   where id = v_task.id;

  select * into v_member from public.linkedin_campaign_members
   where workspace_id = p_workspace_id and id = v_task.campaign_member_id for update;
  select * into v_campaign from public.linkedin_campaigns
   where workspace_id = p_workspace_id and id = v_task.campaign_id;
  select max(position) into v_last from public.linkedin_sequence_steps
   where workspace_id = p_workspace_id and sequence_id = v_campaign.sequence_id;

  if v_member.state = 'waiting' then
    if v_member.current_position >= coalesce(v_last, 0) then
      update public.linkedin_campaign_members
         set state = 'completed', completed_at = now(), next_step_available_at = null
       where id = v_member.id;
      v_member.state := 'completed';
    else
      update public.linkedin_campaign_members
         set current_position = v_member.current_position + 1, next_step_available_at = now()
       where id = v_member.id;
    end if;
  end if;

  insert into public.linkedin_compliance_events
    (workspace_id, event_type, actor_user_id, entity_type, entity_id, details)
  values (p_workspace_id, 'operator_confirmation', auth.uid(), 'linkedin_manual_task', p_task_id,
          jsonb_build_object('kind', v_task.kind, 'campaign_id', v_task.campaign_id));

  return query select true, null::text, v_member.state;
end;
$$;
revoke all on function public.confirm_linkedin_task(uuid, uuid) from public;
grant execute on function public.confirm_linkedin_task(uuid, uuid) to authenticated;

-- 5.5 Skip — the operator declines this lead for the rest of the campaign.
create or replace function public.skip_linkedin_task(
  p_workspace_id uuid,
  p_task_id uuid,
  p_reason text
)
returns table (ok boolean, refused_reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.linkedin_manual_tasks;
begin
  if auth.uid() is null or not public.can_edit_linkedin_sales(p_workspace_id) then
    return query select false, 'forbidden'::text; return;
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    return query select false, 'reason_required'::text; return;
  end if;
  select * into v_task from public.linkedin_manual_tasks
   where workspace_id = p_workspace_id and id = p_task_id for update;
  if v_task.id is null then
    return query select false, 'not_found'::text; return;
  end if;
  if v_task.state not in ('scheduled', 'ready', 'opened', 'copied') then
    return query select false, 'not_skippable:' || v_task.state; return;
  end if;
  update public.linkedin_manual_tasks
     set state = 'skipped', skip_reason = left(trim(p_reason), 500)
   where id = v_task.id;
  update public.linkedin_campaign_members
     set state = 'operator_skipped', state_reason = left(trim(p_reason), 500), next_step_available_at = null
   where workspace_id = p_workspace_id and id = v_task.campaign_member_id and state = 'waiting';
  insert into public.linkedin_compliance_events
    (workspace_id, event_type, actor_user_id, entity_type, entity_id, details)
  values (p_workspace_id, 'task_skipped', auth.uid(), 'linkedin_manual_task', p_task_id,
          jsonb_build_object('reason', left(trim(p_reason), 500)));
  return query select true, null::text;
end;
$$;
revoke all on function public.skip_linkedin_task(uuid, uuid, text) from public;
grant execute on function public.skip_linkedin_task(uuid, uuid, text) to authenticated;

-- 5.6 Suppress from a task — workspace-wide, immediate, recorded.
create or replace function public.suppress_linkedin_lead_from_task(
  p_workspace_id uuid,
  p_task_id uuid,
  p_reason text
)
returns table (ok boolean, refused_reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.linkedin_manual_tasks;
  v_lead public.linkedin_leads;
begin
  if auth.uid() is null or not public.can_edit_linkedin_sales(p_workspace_id) then
    return query select false, 'forbidden'::text; return;
  end if;
  select t.* into v_task from public.linkedin_manual_tasks t
   where t.workspace_id = p_workspace_id and t.id = p_task_id for update;
  if v_task.id is null then
    return query select false, 'not_found'::text; return;
  end if;
  select l.* into v_lead
    from public.linkedin_leads l
    join public.linkedin_campaign_members m on m.workspace_id = l.workspace_id and m.lead_id = l.id
   where m.workspace_id = p_workspace_id and m.id = v_task.campaign_member_id;
  if v_lead.id is null then
    return query select false, 'lead_not_found'::text; return;
  end if;

  insert into public.linkedin_suppression_entries
    (workspace_id, profile_key, canonical_profile_url, reason, source, created_by)
  values (p_workspace_id, v_lead.profile_key, v_lead.canonical_profile_url,
          left(coalesce(p_reason, 'Added from a task'), 500), 'task', auth.uid())
  on conflict (workspace_id, profile_key) do nothing;

  update public.linkedin_leads
     set do_not_contact = true, do_not_contact_reason = left(coalesce(p_reason, 'Added to the suppression list'), 500)
   where workspace_id = p_workspace_id and profile_key = v_lead.profile_key;

  if v_task.state in ('scheduled', 'ready', 'opened', 'copied') then
    update public.linkedin_manual_tasks
       set state = 'cancelled', cancelled_at = now()
     where id = v_task.id;
  end if;
  -- Every waiting membership of this profile, in every campaign.
  update public.linkedin_campaign_members m
     set state = 'suppressed', state_reason = 'suppression_list', next_step_available_at = null
    from public.linkedin_leads l
   where m.workspace_id = p_workspace_id and l.workspace_id = m.workspace_id and l.id = m.lead_id
     and l.profile_key = v_lead.profile_key and m.state = 'waiting';

  insert into public.linkedin_compliance_events
    (workspace_id, event_type, actor_user_id, entity_type, entity_id, details)
  values (p_workspace_id, 'suppression_added', auth.uid(), 'linkedin_lead', v_lead.id,
          jsonb_build_object('profile_key', v_lead.profile_key, 'source', 'task', 'task_id', p_task_id));
  return query select true, null::text;
end;
$$;
revoke all on function public.suppress_linkedin_lead_from_task(uuid, uuid, text) from public;
grant execute on function public.suppress_linkedin_lead_from_task(uuid, uuid, text) to authenticated;

-- 5.7 Cancel future work. Completed history stays.
create or replace function public.cancel_linkedin_campaign(
  p_workspace_id uuid,
  p_campaign_id uuid
)
returns table (ok boolean, refused_reason text, tasks_cancelled integer, members_cancelled integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.linkedin_campaigns;
  v_tasks integer := 0;
  v_members integer := 0;
begin
  if auth.uid() is null or not public.can_edit_linkedin_sales(p_workspace_id) then
    return query select false, 'forbidden'::text, 0, 0; return;
  end if;
  select * into v_campaign from public.linkedin_campaigns
   where workspace_id = p_workspace_id and id = p_campaign_id for update;
  if v_campaign.id is null then
    return query select false, 'not_found'::text, 0, 0; return;
  end if;
  if v_campaign.status not in ('draft', 'active', 'paused') then
    return query select false, 'not_cancellable:' || v_campaign.status, 0, 0; return;
  end if;
  with c as (
    update public.linkedin_manual_tasks
       set state = 'cancelled', cancelled_at = now()
     where workspace_id = p_workspace_id and campaign_id = p_campaign_id
       and state in ('scheduled', 'ready', 'opened', 'copied')
     returning 1)
  select count(*) into v_tasks from c;
  with c as (
    update public.linkedin_campaign_members
       set state = 'cancelled', state_reason = 'campaign_cancelled', next_step_available_at = null
     where workspace_id = p_workspace_id and campaign_id = p_campaign_id and state = 'waiting'
     returning 1)
  select count(*) into v_members from c;
  update public.linkedin_campaigns
     set status = 'cancelled', cancelled_at = now()
   where workspace_id = p_workspace_id and id = p_campaign_id;
  insert into public.linkedin_compliance_events
    (workspace_id, event_type, actor_user_id, entity_type, entity_id, details)
  values (p_workspace_id, 'campaign_cancelled', auth.uid(), 'linkedin_campaign', p_campaign_id,
          jsonb_build_object('tasks_cancelled', v_tasks, 'members_cancelled', v_members));
  return query select true, null::text, v_tasks, v_members;
end;
$$;
revoke all on function public.cancel_linkedin_campaign(uuid, uuid) from public;
grant execute on function public.cancel_linkedin_campaign(uuid, uuid) to authenticated;

-- 5.8 Conservation — every member in exactly one state, and what is open.
create or replace function public.linkedin_campaign_conservation(
  p_workspace_id uuid,
  p_campaign_id uuid
)
returns table (
  members_total bigint,
  waiting bigint,
  completed bigint,
  suppressed bigint,
  operator_skipped bigint,
  structurally_invalid bigint,
  cancelled bigint,
  tasks_open bigint,
  tasks_confirmed bigint,
  tasks_skipped bigint,
  tasks_cancelled bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*) from public.linkedin_campaign_members m where m.workspace_id = p_workspace_id and m.campaign_id = p_campaign_id),
    (select count(*) from public.linkedin_campaign_members m where m.workspace_id = p_workspace_id and m.campaign_id = p_campaign_id and m.state = 'waiting'),
    (select count(*) from public.linkedin_campaign_members m where m.workspace_id = p_workspace_id and m.campaign_id = p_campaign_id and m.state = 'completed'),
    (select count(*) from public.linkedin_campaign_members m where m.workspace_id = p_workspace_id and m.campaign_id = p_campaign_id and m.state = 'suppressed'),
    (select count(*) from public.linkedin_campaign_members m where m.workspace_id = p_workspace_id and m.campaign_id = p_campaign_id and m.state = 'operator_skipped'),
    (select count(*) from public.linkedin_campaign_members m where m.workspace_id = p_workspace_id and m.campaign_id = p_campaign_id and m.state = 'structurally_invalid'),
    (select count(*) from public.linkedin_campaign_members m where m.workspace_id = p_workspace_id and m.campaign_id = p_campaign_id and m.state = 'cancelled'),
    (select count(*) from public.linkedin_manual_tasks t where t.workspace_id = p_workspace_id and t.campaign_id = p_campaign_id and t.state in ('scheduled','ready','opened','copied')),
    (select count(*) from public.linkedin_manual_tasks t where t.workspace_id = p_workspace_id and t.campaign_id = p_campaign_id and t.state = 'operator_confirmed'),
    (select count(*) from public.linkedin_manual_tasks t where t.workspace_id = p_workspace_id and t.campaign_id = p_campaign_id and t.state = 'skipped'),
    (select count(*) from public.linkedin_manual_tasks t where t.workspace_id = p_workspace_id and t.campaign_id = p_campaign_id and t.state = 'cancelled');
$$;
revoke all on function public.linkedin_campaign_conservation(uuid, uuid) from public;
grant execute on function public.linkedin_campaign_conservation(uuid, uuid) to authenticated, service_role;
