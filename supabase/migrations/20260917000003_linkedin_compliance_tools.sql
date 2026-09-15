-- LinkedIn Sales Workspace — compliance tools.
--
-- Five operator tools, each one transaction, each recording an
-- append-only compliance event. They touch only Signal's own rows.
--
--   suppress_linkedin_profile     never prepare this person again, anywhere
--   unsuppress_linkedin_profile   lift that (terminal member states stay final)
--   delete_linkedin_profile_data  a deletion request: remove the person's rows,
--                                 keep only the suppression entry so a later
--                                 import cannot silently bring them back
--   purge_linkedin_expired_leads  delete leads past their retention date
--   export_linkedin_profile_data  everything Signal holds about one profile
--
-- All five require owner/admin/editor; none is granted to service_role.

create or replace function public.suppress_linkedin_profile(
  p_workspace_id uuid,
  p_profile_key text,
  p_reason text,
  p_source text
)
returns table (added boolean, leads_marked integer, members_ended integer, tasks_cancelled integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry_id uuid;
  v_added boolean := false;
  v_leads integer := 0;
  v_members integer := 0;
  v_tasks integer := 0;
begin
  if not public.can_edit_linkedin_sales(p_workspace_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_profile_key !~ '^[a-z0-9][a-z0-9._%-]{0,199}$' then
    raise exception 'invalid profile key' using errcode = '22023';
  end if;
  if p_source not in ('operator', 'import', 'unsubscribe', 'deletion_request') then
    raise exception 'invalid suppression source' using errcode = '22023';
  end if;

  insert into public.linkedin_suppression_entries
    (workspace_id, profile_key, canonical_profile_url, reason, source, created_by)
  values (p_workspace_id, p_profile_key, 'https://www.linkedin.com/in/' || p_profile_key,
          nullif(left(p_reason, 500), ''), p_source, auth.uid())
  on conflict (workspace_id, profile_key) do nothing
  returning id into v_entry_id;
  v_added := v_entry_id is not null;
  if v_entry_id is null then
    select id into v_entry_id from public.linkedin_suppression_entries
     where workspace_id = p_workspace_id and profile_key = p_profile_key;
  end if;

  update public.linkedin_leads
     set do_not_contact = true,
         do_not_contact_reason = 'suppression_list'
   where workspace_id = p_workspace_id and profile_key = p_profile_key
     and (do_not_contact = false or do_not_contact_reason is distinct from 'suppression_list');
  get diagnostics v_leads = row_count;

  update public.linkedin_manual_tasks t
     set state = 'cancelled', cancelled_at = now()
   where t.workspace_id = p_workspace_id
     and t.state in ('scheduled', 'ready', 'opened', 'copied')
     and t.campaign_member_id in (
       select m.id from public.linkedin_campaign_members m
         join public.linkedin_leads l on l.workspace_id = m.workspace_id and l.id = m.lead_id
        where m.workspace_id = p_workspace_id and l.profile_key = p_profile_key);
  get diagnostics v_tasks = row_count;

  update public.linkedin_campaign_members m
     set state = 'suppressed', state_reason = 'suppression_list', next_step_available_at = null
   where m.workspace_id = p_workspace_id and m.state = 'waiting'
     and m.lead_id in (select l.id from public.linkedin_leads l
                        where l.workspace_id = p_workspace_id and l.profile_key = p_profile_key);
  get diagnostics v_members = row_count;

  insert into public.linkedin_compliance_events
    (workspace_id, event_type, actor_user_id, entity_type, entity_id, details)
  values (p_workspace_id, 'suppression_added', auth.uid(), 'linkedin_suppression_entry', v_entry_id,
          jsonb_build_object('source', p_source, 'added', v_added, 'leads_marked', v_leads,
                             'members_ended', v_members, 'tasks_cancelled', v_tasks));

  return query select v_added, v_leads, v_members, v_tasks;
end;
$$;

create or replace function public.unsuppress_linkedin_profile(
  p_workspace_id uuid,
  p_profile_key text
)
returns table (removed boolean, leads_cleared integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry_id uuid;
  v_leads integer := 0;
begin
  if not public.can_edit_linkedin_sales(p_workspace_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.linkedin_suppression_entries
   where workspace_id = p_workspace_id and profile_key = p_profile_key
   returning id into v_entry_id;
  if v_entry_id is null then
    return query select false, 0;
    return;
  end if;
  update public.linkedin_leads
     set do_not_contact = false, do_not_contact_reason = null
   where workspace_id = p_workspace_id and profile_key = p_profile_key
     and do_not_contact_reason = 'suppression_list';
  get diagnostics v_leads = row_count;
  insert into public.linkedin_compliance_events
    (workspace_id, event_type, actor_user_id, entity_type, entity_id, details)
  values (p_workspace_id, 'suppression_removed', auth.uid(), 'linkedin_suppression_entry', v_entry_id,
          jsonb_build_object('leads_cleared', v_leads));
  return query select true, v_leads;
end;
$$;

create or replace function public.delete_linkedin_profile_data(
  p_workspace_id uuid,
  p_profile_key text,
  p_reason text
)
returns table (leads_deleted integer, members_deleted integer, tasks_deleted integer, suppression_kept boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leads integer := 0;
  v_members integer := 0;
  v_tasks integer := 0;
  v_entry_id uuid;
begin
  if not public.can_edit_linkedin_sales(p_workspace_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_profile_key !~ '^[a-z0-9][a-z0-9._%-]{0,199}$' then
    raise exception 'invalid profile key' using errcode = '22023';
  end if;

  select count(*) into v_members
    from public.linkedin_campaign_members m
    join public.linkedin_leads l on l.workspace_id = m.workspace_id and l.id = m.lead_id
   where m.workspace_id = p_workspace_id and l.profile_key = p_profile_key;
  select count(*) into v_tasks
    from public.linkedin_manual_tasks t
    join public.linkedin_campaign_members m on m.workspace_id = t.workspace_id and m.id = t.campaign_member_id
    join public.linkedin_leads l on l.workspace_id = m.workspace_id and l.id = m.lead_id
   where t.workspace_id = p_workspace_id and l.profile_key = p_profile_key;

  -- Members and tasks cascade from the lead.
  delete from public.linkedin_leads
   where workspace_id = p_workspace_id and profile_key = p_profile_key;
  get diagnostics v_leads = row_count;

  -- The one record kept: the key, so a later import cannot bring the
  -- person back as contactable. It is recorded as a deletion request.
  insert into public.linkedin_suppression_entries
    (workspace_id, profile_key, canonical_profile_url, reason, source, created_by)
  values (p_workspace_id, p_profile_key, 'https://www.linkedin.com/in/' || p_profile_key,
          nullif(left(p_reason, 500), ''), 'deletion_request', auth.uid())
  on conflict (workspace_id, profile_key) do update
    set source = 'deletion_request',
        reason = coalesce(excluded.reason, public.linkedin_suppression_entries.reason)
  returning id into v_entry_id;

  insert into public.linkedin_compliance_events
    (workspace_id, event_type, actor_user_id, entity_type, entity_id, details)
  values (p_workspace_id, 'deletion', auth.uid(), 'linkedin_suppression_entry', v_entry_id,
          jsonb_build_object('leads_deleted', v_leads, 'members_deleted', v_members,
                             'tasks_deleted', v_tasks,
                             'profile_key_sha256', encode(sha256(convert_to(p_profile_key, 'UTF8')), 'hex')));

  return query select v_leads, v_members, v_tasks, true;
end;
$$;

create or replace function public.purge_linkedin_expired_leads(
  p_workspace_id uuid,
  p_today date,
  p_limit integer
)
returns table (deleted integer, remaining integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
  v_remaining integer := 0;
begin
  if not public.can_edit_linkedin_sales(p_workspace_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.linkedin_leads
   where id in (
     select id from public.linkedin_leads
      where workspace_id = p_workspace_id
        and retention_until is not null and retention_until <= p_today
      order by retention_until, id
      limit greatest(least(coalesce(p_limit, 500), 5000), 1));
  get diagnostics v_deleted = row_count;
  select count(*) into v_remaining
    from public.linkedin_leads
   where workspace_id = p_workspace_id
     and retention_until is not null and retention_until <= p_today;
  insert into public.linkedin_compliance_events
    (workspace_id, event_type, actor_user_id, entity_type, entity_id, details)
  values (p_workspace_id, 'retention_purge', auth.uid(), null, null,
          jsonb_build_object('as_of', p_today, 'deleted', v_deleted, 'remaining', v_remaining));
  return query select v_deleted, v_remaining;
end;
$$;

create or replace function public.export_linkedin_profile_data(
  p_workspace_id uuid,
  p_profile_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_out jsonb;
begin
  if not public.can_edit_linkedin_sales(p_workspace_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'profile_key', p_profile_key,
    'canonical_profile_url', 'https://www.linkedin.com/in/' || p_profile_key,
    'exported_at', now(),
    'leads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'lead_list', ll.name, 'name', l.customer_provided_name, 'company', l.customer_provided_company,
        'title', l.customer_provided_title, 'source_type', l.source_type, 'source_reference', l.source_reference,
        'processing_basis_note', l.processing_basis_note, 'do_not_contact', l.do_not_contact,
        'do_not_contact_reason', l.do_not_contact_reason, 'retention_until', l.retention_until,
        'created_at', l.created_at) order by l.created_at)
        from public.linkedin_leads l
        join public.linkedin_lead_lists ll on ll.workspace_id = l.workspace_id and ll.id = l.lead_list_id
       where l.workspace_id = p_workspace_id and l.profile_key = p_profile_key), '[]'::jsonb),
    'campaign_memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'campaign', c.name, 'state', m.state, 'state_reason', m.state_reason,
        'current_position', m.current_position, 'completed_at', m.completed_at, 'created_at', m.created_at)
        order by m.created_at)
        from public.linkedin_campaign_members m
        join public.linkedin_leads l on l.workspace_id = m.workspace_id and l.id = m.lead_id
        join public.linkedin_campaigns c on c.workspace_id = m.workspace_id and c.id = m.campaign_id
       where m.workspace_id = p_workspace_id and l.profile_key = p_profile_key), '[]'::jsonb),
    'manual_tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'campaign', c.name, 'kind', t.kind, 'state', t.state, 'draft_text', t.draft_text,
        'local_date', t.local_date, 'opened_at', t.opened_at, 'copied_at', t.copied_at,
        'operator_confirmed_at', t.operator_confirmed_at, 'skip_reason', t.skip_reason,
        'cancelled_at', t.cancelled_at, 'created_at', t.created_at) order by t.created_at)
        from public.linkedin_manual_tasks t
        join public.linkedin_campaign_members m on m.workspace_id = t.workspace_id and m.id = t.campaign_member_id
        join public.linkedin_leads l on l.workspace_id = m.workspace_id and l.id = m.lead_id
        join public.linkedin_campaigns c on c.workspace_id = t.workspace_id and c.id = t.campaign_id
       where t.workspace_id = p_workspace_id and l.profile_key = p_profile_key), '[]'::jsonb),
    'suppression', (
      select jsonb_build_object('reason', s.reason, 'source', s.source, 'created_at', s.created_at)
        from public.linkedin_suppression_entries s
       where s.workspace_id = p_workspace_id and s.profile_key = p_profile_key)
  ) into v_out;

  insert into public.linkedin_compliance_events
    (workspace_id, event_type, actor_user_id, entity_type, entity_id, details)
  values (p_workspace_id, 'export', auth.uid(), null, null,
          jsonb_build_object('profile_key_sha256', encode(sha256(convert_to(p_profile_key, 'UTF8')), 'hex'),
                             'leads', jsonb_array_length(v_out->'leads'),
                             'tasks', jsonb_array_length(v_out->'manual_tasks')));
  return v_out;
end;
$$;

revoke all on function public.suppress_linkedin_profile(uuid, text, text, text) from public;
revoke all on function public.unsuppress_linkedin_profile(uuid, text) from public;
revoke all on function public.delete_linkedin_profile_data(uuid, text, text) from public;
revoke all on function public.purge_linkedin_expired_leads(uuid, date, integer) from public;
revoke all on function public.export_linkedin_profile_data(uuid, text) from public;
grant execute on function public.suppress_linkedin_profile(uuid, text, text, text) to authenticated;
grant execute on function public.unsuppress_linkedin_profile(uuid, text) to authenticated;
grant execute on function public.delete_linkedin_profile_data(uuid, text, text) to authenticated;
grant execute on function public.purge_linkedin_expired_leads(uuid, date, integer) to authenticated;
grant execute on function public.export_linkedin_profile_data(uuid, text) to authenticated;
