-- =====================================================================
-- Bluesky follow campaigns — releasing only what you still hold
-- =====================================================================
--
-- A FOURTH forward-only migration. 20260911000003, ...004 and ...005
-- are merged and are not touched. Additive and idempotent.
--
-- WHY THIS EXISTS
-- ---------------
-- `release_bluesky_campaign_members` returns members to the queue by
-- id, with no check on who holds them. That is safe only while a worker
-- is the sole owner of every row it names — and it is not.
--
-- A lease lapses while its worker is still alive. Another worker
-- reclaims the member, sets its own `claimed_by` and `reservation_id`,
-- and starts work. The first worker then finishes its chunk and
-- releases everything it "leased but never attempted" — including that
-- member — clearing the second worker's lease out from under it. The
-- row goes back to the queue while a request for it may be in flight,
-- and a third worker can pick it up.
--
-- The same helper is what a worker would reach for after being told the
-- audit row is not its to work on, which is exactly the moment the
-- member is most likely to belong to someone else.
--
-- So a release now has to prove ownership. A worker may hand back only
-- the rows it is still holding, under the reservation that paid for
-- them.
--
-- The old function is left in place — it is merged, and removing it
-- would break a caller that has not been updated — but nothing in the
-- worker calls it any more.

create or replace function public.release_bluesky_campaign_members_owned(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_member_ids uuid[],
  p_claimed_by text,
  p_reservation_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released integer;
begin
  update public.bluesky_follow_campaign_members
     set status = case
           when attempt_count > 0 then 'retryable'
           else 'queued'
         end,
         claimed_at = null,
         claimed_by = null,
         lease_expires_at = null,
         reservation_id = null
   where workspace_id = p_workspace_id
     and campaign_id = p_campaign_id
     and id = any(p_member_ids)
     and status in ('claimed', 'running')
     -- OWNERSHIP. Both halves are needed: `claimed_by` identifies the
     -- worker and `reservation_id` identifies the attempt it is part
     -- of, and a worker that lost a lease and reclaimed the same row
     -- under a new reservation is a different owner for this purpose.
     and claimed_by is not distinct from p_claimed_by
     and reservation_id is not distinct from p_reservation_id;
  get diagnostics v_released = row_count;
  return v_released;
end;
$$;

comment on function public.release_bluesky_campaign_members_owned is
  'Return leased members to the queue, but ONLY those this worker still '
  'holds under this reservation. Releasing by id alone let a worker '
  'whose lease had lapsed clear the lease of whoever reclaimed the row.';

revoke all on function public.release_bluesky_campaign_members_owned(
  uuid, uuid, uuid[], text, uuid)
  from public, anon, authenticated;
grant execute on function public.release_bluesky_campaign_members_owned(
  uuid, uuid, uuid[], text, uuid)
  to service_role;

comment on function public.release_bluesky_campaign_members is
  'SUPERSEDED by release_bluesky_campaign_members_owned. Releases by id '
  'with no ownership check, so it can clear a lease belonging to '
  'another worker. Retained only because it is already deployed.';
