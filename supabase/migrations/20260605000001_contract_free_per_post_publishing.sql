-- Phase: contract-free per-post publishing.
--
-- Make execution_queues.contract_id and execution_items.contract_id
-- nullable. Per-post (item-level) approval + scheduling no longer
-- requires an active weekly contract; bulk weekly approval still
-- requires one.
--
-- The FK references and `on delete restrict` semantics are preserved.
-- Existing rows are unchanged (they keep their contract_id values).
-- No data backfill needed.
--
-- The partial unique index
--   execution_queues_one_live_per_contract
--   on (contract_id) where status in (...)
-- is INTENTIONALLY left in place. PostgreSQL treats NULL values as
-- distinct in unique indexes, so multiple contract-free queues are
-- allowed (one per workspace operator activity window). Contract-
-- attached queues still get the one-live-per-contract guarantee.
--
-- No destructive operation. No data loss.

set search_path = public;

alter table public.execution_queues
  alter column contract_id drop not null;

alter table public.execution_items
  alter column contract_id drop not null;

-- Add an audit-trail comment so the next dev reading the schema
-- understands why these columns are nullable.
comment on column public.execution_queues.contract_id is
  'Optional weekly contract reference. NULL when the queue holds contract-free per-post items (operator-approved items scheduled without a weekly contract).';

comment on column public.execution_items.contract_id is
  'Optional weekly contract reference. NULL when the item was created on a per-post (contract-free) approval path. Set metadata.contract_mode = "contract_free_item" when NULL.';
