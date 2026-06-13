-- Phase C1.1 — workspace invitations.
--
-- Additive, RLS-safe, workspace-scoped. Lets an owner/admin invite a
-- user by email even if they have no Signal account yet. The invite
-- token is NEVER stored in plaintext — only a sha256 hash. Acceptance
-- runs through a SECURITY DEFINER RPC so a signed-in invitee who is not
-- yet a member can accept exactly their own invite (matched on their
-- auth email) without weakening RLS.

set search_path = public;

create table if not exists public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null default 'editor'
    check (role in ('admin', 'editor', 'reviewer', 'viewer')), -- never invite as owner
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'expired', 'revoked')),
  token_hash text not null,
  invited_by uuid references auth.users(id) on delete set null,
  accepted_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

create index if not exists workspace_invitations_ws_idx
  on public.workspace_invitations (workspace_id, status, created_at desc);
create index if not exists workspace_invitations_token_idx
  on public.workspace_invitations (token_hash);

-- Adjustment 1 (approved): at most ONE *pending* invite per
-- (workspace, lower(email)). Accepted/expired/revoked history is NOT
-- constrained, so the same email can be re-invited / re-accepted over
-- time without colliding.
create unique index if not exists workspace_invitations_pending_email_idx
  on public.workspace_invitations (workspace_id, lower(email))
  where status = 'pending';

alter table public.workspace_invitations enable row level security;

-- Manage (read/insert/update) is owner+admin only. Acceptance does NOT
-- go through these policies — it uses the SECURITY DEFINER RPC below.
drop policy if exists "workspace_invitations: managers read" on public.workspace_invitations;
create policy "workspace_invitations: managers read"
  on public.workspace_invitations for select
  using (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = workspace_invitations.workspace_id
        and wm.user_id = auth.uid()
        and wm.role in ('owner', 'admin')
    )
  );

drop policy if exists "workspace_invitations: managers insert" on public.workspace_invitations;
create policy "workspace_invitations: managers insert"
  on public.workspace_invitations for insert
  with check (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = workspace_invitations.workspace_id
        and wm.user_id = auth.uid()
        and wm.role in ('owner', 'admin')
    )
  );

drop policy if exists "workspace_invitations: managers update" on public.workspace_invitations;
create policy "workspace_invitations: managers update"
  on public.workspace_invitations for update
  using (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = workspace_invitations.workspace_id
        and wm.user_id = auth.uid()
        and wm.role in ('owner', 'admin')
    )
  );

-- Acceptance RPC. SECURITY DEFINER, but keyed to the CALLER:
--   - auth.uid() must be a signed-in user;
--   - the invite must be pending, unexpired, and addressed to the
--     caller's own auth email (case-insensitive);
--   - inserts the membership (idempotent) and marks the invite accepted.
-- Returns the workspace id on success; raises a typed exception
-- otherwise so the caller can map a clean operator message.
create or replace function public.accept_workspace_invitation(p_token_hash text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_email text;
  v_inv public.workspace_invitations%rowtype;
begin
  if v_user is null then
    raise exception 'accept_workspace_invitation requires an authenticated user' using errcode = '28000';
  end if;
  select lower(email) into v_email from auth.users where id = v_user;

  select * into v_inv
  from public.workspace_invitations
  where token_hash = p_token_hash
  limit 1;

  if not found then
    raise exception 'invitation not found' using errcode = 'P0002';
  end if;
  if v_inv.status <> 'pending' then
    raise exception 'invitation is %', v_inv.status using errcode = 'P0001';
  end if;
  if v_inv.expires_at <= now() then
    update public.workspace_invitations set status = 'expired' where id = v_inv.id;
    raise exception 'invitation expired' using errcode = 'P0001';
  end if;
  if lower(v_inv.email) <> v_email then
    raise exception 'invitation is for a different email' using errcode = 'P0001';
  end if;

  -- Idempotent membership insert (don't duplicate / don't downgrade).
  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_inv.workspace_id, v_user, v_inv.role)
  on conflict (workspace_id, user_id) do nothing;

  update public.workspace_invitations
  set status = 'accepted', accepted_by = v_user, accepted_at = now()
  where id = v_inv.id;

  return v_inv.workspace_id;
end;
$$;

revoke all on function public.accept_workspace_invitation(text) from public;
grant execute on function public.accept_workspace_invitation(text) to authenticated;
