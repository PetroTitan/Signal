-- =====================================================================
-- Campaign dispatch fairness — persisted scheduling state
-- =====================================================================
--
-- WHY
-- ---
-- The cron endpoint is stateless and its runtime is bounded. Before
-- this change it ran the FOLLOW dispatcher with the whole budget and
-- the unfollow dispatcher with whatever was left, and within a kind
-- each due campaign ran chunk after chunk until its quota or the budget
-- was spent. On a runtime that fits one or two chunks per delivery,
-- the earliest-due campaign was served every delivery and every other
-- campaign — a second follow campaign, any unfollow campaign — could
-- wait indefinitely.
--
-- The dispatcher now serves at most ONE chunk per campaign per round
-- and orders each round by when a campaign was last served, so a
-- campaign that was served in one delivery goes to the back of the
-- next. That order has to survive between deliveries, which means it
-- has to live in the database: this column is that state.
--
-- WHAT IT IS NOT
-- --------------
-- Not quota, not a lease, not a lock. It is a hint the scheduler sorts
-- by. A missing or stale value costs at most one round of ordering,
-- never a duplicate claim or an extra unit — reservations and claims
-- are unchanged and remain the only authority on what may be worked.
--
-- Forward-only and idempotent. No RPC body is touched, no grant is
-- widened: the service role already updates this table.

alter table public.bluesky_follow_campaigns
  add column if not exists last_dispatched_at timestamptz;

comment on column public.bluesky_follow_campaigns.last_dispatched_at is
  'When the dispatcher last served this campaign a chunk. Sorted ascending (nulls first) to rotate service across deliveries. A hint, not a lock.';
