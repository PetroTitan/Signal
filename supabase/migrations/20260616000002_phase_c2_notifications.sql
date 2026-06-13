-- Phase C2 — notifications + per-user notification preferences.
--
-- Additive, RLS-safe. Notifications are recipient-scoped (a user reads
-- ONLY their own). Preferences are one row per (workspace, user).
-- Content is always source-of-truth derived by application logic; the
-- schema imposes no fabricated data.

set search_path = public;

-- NOTIFICATIONS --------------------------------------------------------------
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, -- recipient
  type text not null check (type in (
    'publish_failed', 'publish_blocked', 'retry_exhausted', 'stale_claim',
    'connection_expiring', 'invitation_received', 'invitation_accepted',
    'ownership_transferred')),
  status text not null default 'unread' check (status in ('unread', 'read', 'archived')),
  title text not null,
  body text,
  entity_type text,   -- e.g. 'execution_item' | 'platform_connection' | 'workspace'
  entity_id text,     -- deep-link target id
  dedupe_key text,    -- collapses repeated events into one row per recipient
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists notifications_recipient_idx
  on public.notifications (user_id, status, created_at desc);
create index if not exists notifications_ws_idx
  on public.notifications (workspace_id, created_at desc);
-- At most one live row per (recipient, dedupe_key). dedupe_key is null
-- for one-off notifications, which the partial index ignores.
create unique index if not exists notifications_dedupe_idx
  on public.notifications (user_id, dedupe_key)
  where dedupe_key is not null;

alter table public.notifications enable row level security;

drop policy if exists "notifications: recipient reads" on public.notifications;
create policy "notifications: recipient reads"
  on public.notifications for select
  using (user_id = auth.uid());

drop policy if exists "notifications: recipient updates" on public.notifications;
create policy "notifications: recipient updates"
  on public.notifications for update
  using (user_id = auth.uid());

-- A workspace member may create notifications for that workspace (the
-- recipient is always set to a co-member by app logic). The cron
-- scheduler uses the service-role client, which bypasses RLS for the
-- failure/stale-claim alerts it raises.
drop policy if exists "notifications: members insert" on public.notifications;
create policy "notifications: members insert"
  on public.notifications for insert
  with check (public.is_workspace_member(workspace_id));

-- NOTIFICATION PREFERENCES ---------------------------------------------------
create table if not exists public.notification_preferences (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email_enabled boolean not null default false,    -- off until an email provider exists
  telegram_enabled boolean not null default false,
  digest_cadence text not null default 'disabled'
    check (digest_cadence in ('daily', 'weekly', 'disabled')),
  connection_warning_days int not null default 3
    check (connection_warning_days between 0 and 30),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

alter table public.notification_preferences enable row level security;

-- Own row only.
drop policy if exists "notification_preferences: own read" on public.notification_preferences;
create policy "notification_preferences: own read"
  on public.notification_preferences for select
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

drop policy if exists "notification_preferences: own insert" on public.notification_preferences;
create policy "notification_preferences: own insert"
  on public.notification_preferences for insert
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

drop policy if exists "notification_preferences: own update" on public.notification_preferences;
create policy "notification_preferences: own update"
  on public.notification_preferences for update
  using (user_id = auth.uid());
