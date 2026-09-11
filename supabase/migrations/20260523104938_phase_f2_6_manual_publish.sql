-- Phase F2.6 — manual publishing workflow.
--
-- Three changes:
--   1. New execution_items.status value: 'ready_for_manual_publish'.
--      Distinct from 'ready' so an item that the operator has opted
--      into the manual path is visibly separated from one waiting
--      for the API path.
--   2. publish_history.mode column ('api' | 'manual') with default
--      'api'. Backfills existing rows from metadata.publish_method
--      when present, otherwise leaves the default.
--   3. Partial unique index on (workspace_id, provider_permalink) so
--      the same Reddit permalink cannot be recorded twice — defends
--      against accidental double-submits on the manual path.

set search_path = public;

-- 1. execution_items.status: add 'ready_for_manual_publish'.
alter table public.execution_items
  drop constraint if exists execution_items_status_check;
alter table public.execution_items
  add constraint execution_items_status_check check (status in (
    'pending_authorization',
    'authorized',
    'scheduled',
    'ready',
    'ready_for_manual_publish',
    'running',
    'completed',
    'blocked',
    'backlogged',
    'skipped',
    'paused',
    'failed',
    'cancelled'
  ));

-- 2. publish_history.mode.
alter table public.publish_history
  add column if not exists mode text not null default 'api'
    check (mode in ('api', 'manual'));

-- Backfill from metadata.publish_method on prior rows (F2.5 manual
-- fallback rows used this metadata field). New rows go through the
-- column.
update public.publish_history
   set mode = 'manual'
 where mode = 'api'
   and (metadata ->> 'publish_method') = 'manual';

-- 3. Duplicate-permalink guard. Workspace-scoped partial unique
--    index keyed on the normalized permalink. NULL permalinks
--    (blocked/failed rows) are exempt.
drop index if exists publish_history_workspace_permalink_unique;
create unique index publish_history_workspace_permalink_unique
  on public.publish_history (workspace_id, provider_permalink)
  where provider_permalink is not null;
