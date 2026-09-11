-- SECURITY DEFINER RPC to atomically bootstrap a new workspace.
--
-- Why: the previous Node-level path did three sequential inserts as the
-- authenticated user. The INSERT…RETURNING * on workspaces ran the new
-- row through the SELECT policy (is_workspace_member), which fails
-- because the member row does not exist yet. supabase-js's .single()
-- then reported "no row found" and the bootstrap threw, crashing the
-- app shell.
--
-- This RPC runs as SECURITY DEFINER but takes auth.uid() from the
-- caller, so the user can only create workspaces that belong to
-- themselves. No service-role key needed. RLS is not weakened — the
-- RPC simply performs the three inserts in one statement and returns
-- the workspace id.

set search_path = public;

create or replace function public.bootstrap_workspace(workspace_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_workspace_id uuid;
begin
  if v_user is null then
    raise exception 'bootstrap_workspace requires an authenticated user' using errcode = '28000';
  end if;
  if workspace_name is null or btrim(workspace_name) = '' then
    raise exception 'bootstrap_workspace requires a non-empty name' using errcode = '22023';
  end if;

  insert into public.workspaces (name, created_by)
  values (btrim(workspace_name), v_user)
  returning id into v_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, v_user, 'owner');

  insert into public.workspace_settings (workspace_id, demo_mode)
  values (v_workspace_id, false);

  insert into public.activity_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, title, description
  ) values (
    v_workspace_id, v_user, 'workspace.created', 'workspace', v_workspace_id,
    'Workspace created', 'Default workspace bootstrapped on first authenticated visit.'
  );

  return v_workspace_id;
end;
$$;

revoke all on function public.bootstrap_workspace(text) from public;
grant execute on function public.bootstrap_workspace(text) to authenticated;
