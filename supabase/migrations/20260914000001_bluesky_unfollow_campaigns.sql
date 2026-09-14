-- Bluesky Unfollow Campaigns — autonomous, frozen-queue record deletion.
--
-- Forward-only and strictly additive. 20260911000001..6, 20260912000001..3
-- are deployed and are NOT edited. Every statement is idempotent:
-- `if not exists` on tables and indexes, `create or replace` for
-- functions, `add column if not exists`, and guarded `do $$` blocks for
-- CHECK constraints, which cannot be `if not exists`.
--
-- WHY THIS EXTENDS THE CAMPAIGN TABLES INSTEAD OF FORKING THEM
-- -----------------------------------------------------------
-- The hard part of this subsystem is not "delete a record". It is the
-- part that took four hotfix migrations to get right: an atomic
-- reservation that is a ROW with an owner, a fixed lock order, an
-- append-only ledger whose `provider_intent_at` is stamped in the same
-- transaction as the unit it spends, settlement that folds durable
-- facts instead of trusting a worker's memory, and a sweep that can
-- tell "nobody is holding this row" from "this unit was spent".
--
-- Rebuilding that for Unfollow would mean re-earning every one of those
-- defects. So Unfollow reuses those functions UNCHANGED —
-- `reserve_bluesky_campaign_quota`, `consume_bluesky_member_quota`,
-- `apply_bluesky_run_outcome`, `sweep_bluesky_quota_reservations`,
-- `release_bluesky_campaign_members_owned` are all campaign-kind
-- agnostic and are called as they are.
--
-- Only two things genuinely differ, and only those are new here:
--   1. the ACTION the worker claims (`unfollow`, not `follow`), and
--   2. how an outcome is CLASSIFIED and ACCOUNTED.
--
-- WHAT PROTECTS FOLLOW FROM THIS
-- ------------------------------
-- The worst failure available to this change is the Follow dispatcher
-- picking up an Unfollow campaign and FOLLOWING a queue of people the
-- operator asked to unfollow. A `where kind = 'follow'` in TypeScript
-- is not adequate protection against that, so the guarantee is also
-- made in the database: `claim_bluesky_campaign_action` — the Follow
-- path's own RPC — now RAISES when the campaign is not a follow
-- campaign. That is a narrowing change. It can only ever refuse.

set search_path = public;

-- =====================================================================
-- 1. The discriminator
-- =====================================================================

alter table public.bluesky_follow_campaigns
  add column if not exists kind text not null default 'follow';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bluesky_campaigns_kind_check'
  ) then
    alter table public.bluesky_follow_campaigns
      add constraint bluesky_campaigns_kind_check
      check (kind in ('follow', 'unfollow'));
  end if;
end;
$$;

comment on column public.bluesky_follow_campaigns.kind is
  'follow | unfollow. Existing rows default to follow. The dispatcher '
  'filters on this, and claim_bluesky_campaign_action REFUSES a '
  'non-follow campaign, so a mis-filter cannot turn an unfollow queue '
  'into a wave of follows.';

-- A campaign's kind is decided at creation and is never editable. A
-- campaign that changed kind mid-queue would act on its members with
-- the opposite of the operator's intent.
create or replace function public.bluesky_campaign_kind_is_immutable()
returns trigger
language plpgsql
as $kind$
begin
  if new.kind is distinct from old.kind then
    raise exception
      'bluesky_follow_campaigns.kind is immutable (% -> %)', old.kind, new.kind;
  end if;
  return new;
end;
$kind$;

drop trigger if exists bluesky_campaign_kind_immutable
  on public.bluesky_follow_campaigns;
create trigger bluesky_campaign_kind_immutable
  before update on public.bluesky_follow_campaigns
  for each row execute function public.bluesky_campaign_kind_is_immutable();

-- The dispatcher's hot path, per kind. The existing partial index on
-- (next_run_at) where status='active' is left exactly as it is.
create index if not exists bluesky_campaigns_kind_due_idx
  on public.bluesky_follow_campaigns (kind, next_run_at)
  where status = 'active';

-- =====================================================================
-- 2. The two campaign states the brief requires and Follow never had
-- =====================================================================
--
-- Follow keeps its build state on the import job. The brief requires
-- `building_queue` and `ready` as CAMPAIGN states, so the campaign's
-- own lifecycle can be read without joining the job. Widening a CHECK
-- admits values; it invalidates no existing row and changes no
-- existing behaviour.

do $$
begin
  alter table public.bluesky_follow_campaigns
    drop constraint if exists bluesky_follow_campaigns_status_check;
  alter table public.bluesky_follow_campaigns
    add constraint bluesky_follow_campaigns_status_check
    check (status in (
      'draft',
      'building_queue',             -- the durable queue build is running
      'ready',                      -- frozen and complete; awaiting the
                                    -- operator's single activation
      'active',
      'paused',
      'completed',
      'reauthorization_required',
      'rate_limited',
      'failed',
      'cancelled'
    ));
end;
$$;

-- =====================================================================
-- 3. Member states for a deletion queue
-- =====================================================================
--
-- `already_not_following` is the neutral success the brief calls for:
-- the operator's intent is satisfied, no record was deleted, and NO
-- QUOTA IS CONSUMED.
--
-- `provider_in_flight` is a real member state here, not only a column
-- on the action row, because the UI must be able to show an operator
-- which profiles have an outstanding public act against them.

do $$
begin
  alter table public.bluesky_follow_campaign_members
    drop constraint if exists bluesky_follow_campaign_members_status_check;
  alter table public.bluesky_follow_campaign_members
    add constraint bluesky_follow_campaign_members_status_check
    check (status in (
      'queued',
      'claimed',
      'running',                 -- retained: deployed follow rows use it
      'provider_in_flight',      -- a delete MAY have been issued
      'succeeded',
      'already_following',       -- follow campaigns
      'already_not_following',   -- unfollow campaigns; consumes no quota
      'protected',
      'skipped',
      'retryable',
      'failed_structural',
      'cancelled'
    ));
end;
$$;

-- Why a member was protected. Displayed verbatim to the operator: a
-- skipped profile with no stated reason is indistinguishable from a bug.
alter table public.bluesky_follow_campaign_members
  add column if not exists protected_reason text;

comment on column public.bluesky_follow_campaign_members.protected_reason is
  'Operator-facing explanation for a `protected` member. Never null '
  'when status = protected: "excluded" with no reason cannot be told '
  'apart from a defect.';

-- Where this member's follow-record identity came from.
--
-- `provider_record_uri/rkey/cid` already exist on this table and were
-- documented as "captured from createRecord. Never derived from the
-- DID". For an unfollow campaign they carry the record to DELETE, and
-- the source matters: a key read at import time can be STALE by
-- execution time, so the worker re-resolves and this column records
-- which reading it acted on.
alter table public.bluesky_follow_campaign_members
  add column if not exists provider_record_source text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'bluesky_campaign_members_record_source_check'
  ) then
    alter table public.bluesky_follow_campaign_members
      add constraint bluesky_campaign_members_record_source_check
      check (provider_record_source is null or provider_record_source in (
        'create_record',      -- minted by this system
        'list_records',       -- read from the acting repository itself
        'relationship_read'   -- read from getRelationships().following
      ));
  end if;
end;
$$;

comment on column public.bluesky_follow_campaign_members.provider_record_source is
  'How the rkey now on this row was obtained. Every value names a '
  'PROVIDER reading. There is deliberately no value meaning "derived": '
  'observed rkeys use incompatible schemes within one response, so any '
  'derivation rule is wrong for most rows.';

-- =====================================================================
-- 4. Run counters for a deletion queue
-- =====================================================================

alter table public.bluesky_follow_campaign_runs
  add column if not exists already_absent_count integer not null default 0,
  add column if not exists protected_count integer not null default 0,
  add column if not exists reconciliation_required_count integer not null default 0;

comment on column public.bluesky_follow_campaign_runs.already_absent_count is
  'Members already not followed when the run reached them. A neutral '
  'success: the operator''s intent holds, nothing was deleted, and no '
  'quota was consumed.';

-- =====================================================================
-- 5. Identity daily usage — the SHARED budget, in provider points
-- =====================================================================
--
-- WHAT BLUESKY ACTUALLY CHARGES (docs.bsky.app/docs/rate-limits, read
-- 2026-09-14 — not carried over from the Follow work):
--
--     5,000 points/hour and 35,000 points/day, per ACCOUNT (DID)
--     CREATE 3 points · UPDATE 2 points · DELETE 1 point
--     Overall API requests: 3,000 per 5 minutes, limited BY IP
--     createSession: 30 per 5 min, 300 per day, per account
--
-- A DELETE therefore costs ONE THIRD of a CREATE, and the provider
-- would permit 35,000 unfollows a day on points alone. Points are NOT
-- the binding constraint for Unfollow, and sizing the ceiling from them
-- would be sizing it from the wrong number. The same page says, in
-- terms: "moderation systems and other application-specific limits may
-- apply" and "bulk or spammy interactions are against the Community
-- Guidelines". That is the binding constraint, and it is a judgement,
-- not an arithmetic.
--
-- THE DECISION THE BRIEF ASKS FOR: ONE COMBINED CEILING.
--
-- The provider's budget is a single points pool per DID, so two
-- independent count-based ceilings would model something that does not
-- exist. Signal therefore keeps a combined POINT envelope, and
-- Unfollow yields to Follow inside it:
--
--   • Follow keeps its own count ceiling of 1,000 creates/day,
--     UNCHANGED and independently enforced. Its arithmetic is not
--     touched by this migration.
--   • Unfollow may spend what is left of a 3,000-POINT envelope after
--     follows (×3) and unfollows (×1) are both counted — and never
--     more than 1,000 deletes in a day regardless.
--
-- 3,000 points is exactly what Follow's existing 1,000-create ceiling
-- already costs, so the pair can never exceed the headroom the Follow
-- architecture already justified: 8.6% of the documented daily budget.
-- The asymmetry is deliberate and is the conservative direction — the
-- newer, publicly-irreversible capability yields to the established
-- one, never the reverse.

alter table public.bluesky_identity_daily_usage
  add column if not exists unfollows_deleted integer not null default 0,
  add column if not exists delete_attempts_made integer not null default 0;

comment on column public.bluesky_identity_daily_usage.unfollows_deleted is
  'Follow records actually DELETED today by this identity, across every '
  'unfollow campaign. One point each against the shared envelope.';

-- Points consumed today, as the provider counts them. A generated
-- column so nothing can write a value that disagrees with the two
-- counters it is derived from.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'bluesky_identity_daily_usage'
       and column_name = 'provider_points_spent'
  ) then
    alter table public.bluesky_identity_daily_usage
      add column provider_points_spent integer
      generated always as (follows_created * 3 + unfollows_deleted * 1) stored;
  end if;
end;
$$;

comment on column public.bluesky_identity_daily_usage.provider_points_spent is
  'CREATE=3, DELETE=1, per the published limits. Generated, so it can '
  'never disagree with the counters it is computed from.';

-- =====================================================================
-- 6. The operator's "never unfollow" allowlist
-- =====================================================================
--
-- Separate from `bluesky_candidates.protected`, which only covers DIDs
-- that were imported as candidates for one identity. An operator must
-- be able to protect an account they have never imported, and to
-- protect it for every campaign at once.

create table if not exists public.bluesky_unfollow_allowlist (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- NULL = every identity in the workspace. Non-null = that identity.
  operator_account_id uuid references public.growth_accounts(id) on delete cascade,

  subject_did text not null check (subject_did like 'did:%'),
  -- What it looked like when the operator added it. Never backfilled.
  subject_handle_at_add text,
  reason text,

  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.bluesky_unfollow_allowlist is
  'Profiles this workspace will never unfollow automatically. Checked '
  'at import AND again immediately before provider intent, because an '
  'operator may add an entry after a queue was frozen.';

-- One entry per (workspace, identity, DID), with the workspace-wide
-- entry keyed separately because a partial index is the only way to
-- make NULL unique.
create unique index if not exists bluesky_unfollow_allowlist_identity_idx
  on public.bluesky_unfollow_allowlist (workspace_id, operator_account_id, subject_did)
  where operator_account_id is not null;

create unique index if not exists bluesky_unfollow_allowlist_global_idx
  on public.bluesky_unfollow_allowlist (workspace_id, subject_did)
  where operator_account_id is null;

create index if not exists bluesky_unfollow_allowlist_lookup_idx
  on public.bluesky_unfollow_allowlist (workspace_id, subject_did);

drop trigger if exists bluesky_unfollow_allowlist_touch
  on public.bluesky_unfollow_allowlist;
create trigger bluesky_unfollow_allowlist_touch
  before update on public.bluesky_unfollow_allowlist
  for each row execute function public.touch_updated_at();

alter table public.bluesky_unfollow_allowlist enable row level security;

drop policy if exists "bluesky_unfollow_allowlist: members read"
  on public.bluesky_unfollow_allowlist;
create policy "bluesky_unfollow_allowlist: members read"
  on public.bluesky_unfollow_allowlist for select
  using (public.is_workspace_member(workspace_id));

-- Writes need the permission, not merely membership — the same
-- reasoning as every other campaign table: an authenticated client
-- holding an anon key can POST to PostgREST directly, so a server
-- action is not the authorization boundary. Removing an entry is the
-- dangerous direction (it un-protects someone), and it is gated
-- identically.
drop policy if exists "bluesky_unfollow_allowlist: managers insert"
  on public.bluesky_unfollow_allowlist;
create policy "bluesky_unfollow_allowlist: managers insert"
  on public.bluesky_unfollow_allowlist for insert
  with check (public.can_manage_bluesky_campaigns(workspace_id));

drop policy if exists "bluesky_unfollow_allowlist: managers update"
  on public.bluesky_unfollow_allowlist;
create policy "bluesky_unfollow_allowlist: managers update"
  on public.bluesky_unfollow_allowlist for update
  using (public.can_manage_bluesky_campaigns(workspace_id))
  with check (public.can_manage_bluesky_campaigns(workspace_id));

drop policy if exists "bluesky_unfollow_allowlist: managers delete"
  on public.bluesky_unfollow_allowlist;
create policy "bluesky_unfollow_allowlist: managers delete"
  on public.bluesky_unfollow_allowlist for delete
  using (public.can_manage_bluesky_campaigns(workspace_id));

grant select, insert, update, delete
  on public.bluesky_unfollow_allowlist to service_role;

-- =====================================================================
-- 7. THE CONFLICT POLICY — one unresolved intention per (identity, DID)
-- =====================================================================
--
-- The deployed guard is:
--
--   unique (workspace_id, operator_account_id, subject_did, action_type)
--     where status in ('pending', 'running')
--
-- `action_type` is IN THE KEY, so a pending Follow and a pending
-- Unfollow for the same person, from the same account, are both
-- permitted today. Two campaigns can therefore fight over one subject
-- and the most recent write silently wins — a person is followed,
-- unfollowed, followed again, and Signal considers every step correct.
--
-- The fix is a TOTAL index: at most one unresolved relationship
-- intention per (workspace, identity, subject), whatever its type.
-- The deployed per-type index is LEFT IN PLACE. It is implied by this
-- one and removing it would be an edit to merged work for no gain.
--
-- `reconciliation_required` is deliberately NOT in the predicate. Such
-- an action is terminal for the action and unresolved for the member;
-- it may sit for days while relationship truth is read, and blocking
-- the opposite intention for that whole period would convert an
-- ambiguity into a permanent lock. The worker refuses to mutate a
-- member in that state on its own, which is the narrower guard.

do $$
declare
  v_conflicts integer;
begin
  select count(*) into v_conflicts
    from (
      select workspace_id, operator_account_id, subject_did
        from public.bluesky_relationship_actions
       where status in ('pending', 'running')
       group by workspace_id, operator_account_id, subject_did
      having count(*) > 1
    ) c;

  if v_conflicts > 0 then
    -- Fail the migration LOUDLY rather than skipping the index. A
    -- silently absent conflict guard is the defect this migration
    -- exists to close, and the rows involved need a human decision —
    -- see docs/relationships/unfollow-campaigns-runbook.md, "Applying
    -- the migration".
    raise exception
      'Cannot create the relationship-intention conflict index: % (identity, subject) pair(s) already hold more than one in-flight action. Resolve them first — see the unfollow runbook.',
      v_conflicts;
  end if;
end;
$$;

create unique index if not exists bluesky_relationship_actions_one_intent
  on public.bluesky_relationship_actions
     (workspace_id, operator_account_id, subject_did)
  where status in ('pending', 'running');

comment on index public.bluesky_relationship_actions_one_intent is
  'At most ONE unresolved relationship intention per (workspace, '
  'identity, subject) — follow or unfollow. The deployed per-type index '
  'allowed a pending follow and a pending unfollow to coexist, which is '
  'how two campaigns end up fighting over one person. Enforced here '
  'because a check-then-insert in application code has a window and '
  'this does not.';

-- =====================================================================
-- 8. Protection, evaluated by the database
-- =====================================================================
--
-- Called at import AND again immediately before provider intent, from
-- inside `claim_bluesky_unfollow_action` — under the same transaction
-- that creates the action row. Re-checking matters because an operator
-- may add an allowlist entry after a queue was frozen, and a queue
-- frozen last week must not unfollow someone protected yesterday.
--
-- Returns the REASON, not a boolean, because a skipped profile with no
-- stated reason cannot be told apart from a bug.

create or replace function public.bluesky_unfollow_protection_reason(
  p_workspace_id uuid,
  p_operator_account_id uuid,
  p_actor_did text,
  p_subject_did text
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- The acting identity itself. First, unconditional, and not
  -- overridable by any setting: an account cannot unfollow itself, and
  -- an attempt would mean the DID resolution that built the queue was
  -- wrong about who is acting.
  if p_actor_did is not null and p_subject_did = p_actor_did then
    return 'This is the acting account itself.';
  end if;

  if exists (
    select 1 from public.bluesky_unfollow_allowlist a
     where a.workspace_id = p_workspace_id
       and a.subject_did = p_subject_did
       and (a.operator_account_id is null
            or a.operator_account_id = p_operator_account_id)
  ) then
    return 'On your Never unfollow list.';
  end if;

  if exists (
    select 1 from public.bluesky_candidates c
     where c.workspace_id = p_workspace_id
       and c.operator_account_id = p_operator_account_id
       and c.subject_did = p_subject_did
       and c.protected
  ) then
    return 'Marked protected in your relationships list.';
  end if;

  return null;
end;
$$;

comment on function public.bluesky_unfollow_protection_reason is
  'The single authority on whether a profile may be unfollowed, and '
  'WHY not. Evaluated again inside the action claim, in the same '
  'transaction as provider intent, because account state changes '
  'between import and execution.';

revoke all on function public.bluesky_unfollow_protection_reason(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.bluesky_unfollow_protection_reason(uuid, uuid, text, text)
  to service_role;

-- =====================================================================
-- 9. The Follow path refuses a campaign that is not a follow campaign
-- =====================================================================
--
-- A narrowing change to a deployed Follow function. Its signature,
-- return shape and every existing branch are unchanged; one guard is
-- added at the top, and the `unique_violation` handler is corrected so
-- the new total conflict index cannot be mistaken for "I lost the race
-- for this member".
--
-- Without the correction: the handler re-selects by (campaign, member),
-- finds nothing when the violation came from the conflict index, and
-- computes `needs_reconcile := null not in (...)` — which is NULL, not
-- true. The TypeScript mapping already falls through to DENIED on a
-- null action id, so this was safe by accident. It is now safe on
-- purpose, and says which of the two happened.

create or replace function public.claim_bluesky_campaign_action(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_run_id uuid,
  p_member_id uuid,
  p_operator_account_id uuid,
  p_subject_did text,
  p_subject_handle text,
  p_actor_did text,
  p_actor_handle text,
  p_initiated_by uuid
)
returns table (
  action_id uuid,
  may_mutate boolean,
  needs_reconcile boolean,
  terminal boolean,
  existing_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.bluesky_relationship_actions;
  v_id uuid;
  v_kind text;
begin
  -- THE GUARD, AND THE ONLY LOGIC ADDED TO THIS FUNCTION.
  --
  -- A follow campaign is the only thing this may act for. Raising
  -- rather than returning a verdict: a follow worker reaching an
  -- unfollow campaign means the dispatcher's filter failed, and the
  -- consequence would be FOLLOWING a queue of people the operator asked
  -- to unfollow. That is not a condition to degrade gracefully through
  -- — it is one to stop and be seen. The dispatcher records a campaign
  -- that threw as `failed`, which is exactly the visibility this needs.
  --
  -- EVERYTHING BELOW IS THE BODY DEPLOYED BY 20260911000005,
  -- REPRODUCED VERBATIM — apart from the exception handler, noted
  -- there. `create or replace` rewrites the whole body, and that
  -- migration fixed two defects subtle enough to reintroduce by
  -- copying the wrong version of this function:
  --
  --   • the MARKER decides, not the status. A pending row with no
  --     in-flight marker means nothing was ever sent, and the member is
  --     still owed its FIRST attempt — treating it as reconciliation
  --     silenced that member permanently.
  --   • a fresh row carries NO in-flight marker. Creating the row says
  --     "this worker intends to handle this member", not "a request is
  --     in flight", and conflating the two is what caused the above.
  --
  -- The first draft of this migration did copy the wrong version. The
  -- deployed `intent-and-locking.pg.test.ts` and `rpc-behaviour.pg.test.ts`
  -- failed on a real PostgreSQL and named both defects.
  select c.kind into v_kind
    from public.bluesky_follow_campaigns c
   where c.id = p_campaign_id
     and c.workspace_id = p_workspace_id;

  if v_kind is null then
    raise exception 'claim_bluesky_campaign_action: unknown campaign %', p_campaign_id;
  elsif v_kind <> 'follow' then
    raise exception
      'claim_bluesky_campaign_action refuses campaign % of kind %: this function creates FOLLOW actions only',
      p_campaign_id, v_kind;
  end if;
  select * into v_existing
    from public.bluesky_relationship_actions
   where campaign_id = p_campaign_id
     and campaign_member_id = p_member_id
     and status <> 'skipped'
   for update;

  if v_existing.id is not null then
    action_id := v_existing.id;
    existing_status := v_existing.status;

    if v_existing.status in ('succeeded', 'failed', 'reconciliation_required') then
      may_mutate := false; needs_reconcile := false; terminal := true;
      return next; return;
    end if;

    -- The MARKER decides, not the status.
    --
    -- With the marker set, a createRecord may already have reached a
    -- real person: reconciliation only. Without it, nothing was ever
    -- sent — a worker claimed this row and died before spending its
    -- unit — and the member is still owed its first attempt.
    if v_existing.provider_in_flight_at is not null then
      may_mutate := false;
      needs_reconcile := true;
    else
      may_mutate := true;
      needs_reconcile := false;
    end if;
    terminal := false;

    update public.bluesky_relationship_actions
       set status = 'running',
           started_at = coalesce(started_at, now()),
           campaign_run_id = coalesce(campaign_run_id, p_run_id)
     where id = v_existing.id;
    return next; return;
  end if;

  -- A fresh row. No in-flight marker: nothing has been sent yet, and
  -- saying otherwise is what caused defect 1.
  insert into public.bluesky_relationship_actions (
    workspace_id, operator_account_id, candidate_id, batch_id,
    action_type, subject_did, subject_handle_at_action,
    actor_did, actor_handle_at_action, status,
    source_target_profile_ids, initiated_by, initiator_kind,
    campaign_id, campaign_run_id, campaign_member_id,
    provider_in_flight_at, started_at
  )
  values (
    p_workspace_id, p_operator_account_id, null, null,
    'follow', p_subject_did, p_subject_handle,
    p_actor_did, p_actor_handle, 'running',
    '{}', p_initiated_by, 'operator_batch',
    p_campaign_id, p_run_id, p_member_id,
    null, now()
  )
  returning id into v_id;

  action_id := v_id;
  may_mutate := true;
  needs_reconcile := false;
  terminal := false;
  existing_status := null;
  return next;
exception
  when unique_violation then
    -- Lost the race to another worker between the select and the
    -- insert. Fall back to whatever it created.
    select * into v_existing
      from public.bluesky_relationship_actions
     where campaign_id = p_campaign_id
       and campaign_member_id = p_member_id
       and status <> 'skipped';

    -- OR THE NEW TOTAL CONFLICT INDEX FIRED, which the deployed
    -- version could not encounter: something else holds the only
    -- unresolved intention for this (identity, subject) — an unfollow
    -- campaign, or a manual action. The re-select above then finds
    -- nothing, and every expression below evaluates against NULL. The
    -- TypeScript mapping already falls through to DENIED on a null
    -- action id, so this was safe by accident; it is now safe on
    -- purpose, and says which of the two happened.
    if v_existing.id is null then
      action_id := null;
      may_mutate := false;
      needs_reconcile := false;
      terminal := false;
      existing_status := 'conflicting_intent';
      return next; return;
    end if;

    action_id := v_existing.id;
    existing_status := v_existing.status;
    terminal := v_existing.status in
      ('succeeded', 'failed', 'reconciliation_required');
    needs_reconcile :=
      not terminal and v_existing.provider_in_flight_at is not null;
    may_mutate := false;
    return next;
end;
$$;

revoke all on function public.claim_bluesky_campaign_action(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_bluesky_campaign_action(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, uuid)
  to service_role;

-- =====================================================================
-- 10. Claiming the UNFOLLOW action for one member
-- =====================================================================
--
-- The unfollow sibling of `claim_bluesky_campaign_action`, and the only
-- place an `unfollow` action row is created for a campaign.
--
-- It does four things the follow version does not, all of them in the
-- SAME transaction, which is what makes them meaningful:
--
--   1. RE-CHECKS PROTECTION. A queue frozen last week must not
--      unfollow someone the operator protected yesterday.
--   2. REFUSES A CONFLICT explicitly, so the operator is told which
--      person is contested rather than watching a member sit idle.
--   3. PERSISTS THE EXACT RECORD IDENTITY it was given — uri, rkey and
--      cid — on the action row, BEFORE anything is sent. A delete whose
--      target is not durably recorded first is a delete nobody can
--      audit afterwards.
--   4. REFUSES AN EMPTY RKEY. There is no derivation from a subject DID
--      to a record key; a caller that has not resolved one has nothing
--      safe to delete and must reconcile instead.
--
-- The verdict is a closed set with its own `refused_reason`, because
-- "this member is contested" and "this member is protected" need
-- different words in front of an operator, and collapsing them into
-- the follow path's three booleans would lose exactly that.

create or replace function public.claim_bluesky_unfollow_action(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_run_id uuid,
  p_member_id uuid,
  p_operator_account_id uuid,
  p_subject_did text,
  p_subject_handle text,
  p_actor_did text,
  p_actor_handle text,
  p_record_uri text,
  p_record_rkey text,
  p_record_cid text,
  p_initiated_by uuid
)
returns table (
  action_id uuid,
  may_mutate boolean,
  needs_reconcile boolean,
  terminal boolean,
  refused_reason text,
  protected_reason text,
  existing_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.bluesky_relationship_actions;
  v_kind text;
  v_status text;
  v_protection text;
  v_id uuid;
begin
  may_mutate := false;
  needs_reconcile := false;
  terminal := false;

  -- ── The campaign must be an unfollow campaign, and must be running.
  select c.kind, c.status into v_kind, v_status
    from public.bluesky_follow_campaigns c
   where c.id = p_campaign_id
     and c.workspace_id = p_workspace_id;

  if v_kind is null then
    refused_reason := 'unknown_campaign'; return next; return;
  elsif v_kind <> 'unfollow' then
    -- Symmetric to the follow guard, and for the same reason: an
    -- unfollow action created against a follow campaign would delete
    -- records the operator asked to create.
    raise exception
      'claim_bluesky_unfollow_action refuses campaign % of kind %: this function creates UNFOLLOW actions only',
      p_campaign_id, v_kind;
  end if;

  -- A campaign an operator has stopped may not start new public acts.
  -- Checked here as well as in the dispatcher because this is the last
  -- point before an action row exists, and it is inside the
  -- transaction that would create it.
  if v_status in ('cancelled', 'paused', 'completed', 'failed') then
    refused_reason := 'campaign_' || v_status; return next; return;
  end if;

  -- ── The member must belong to this campaign.
  if not exists (
    select 1 from public.bluesky_follow_campaign_members m
     where m.id = p_member_id
       and m.campaign_id = p_campaign_id
       and m.workspace_id = p_workspace_id
  ) then
    refused_reason := 'member_mismatch'; return next; return;
  end if;

  -- ── PROTECTION, re-evaluated now. Before the conflict check and
  --    before any row is written, so a protected profile never even
  --    contends for the conflict index.
  v_protection := public.bluesky_unfollow_protection_reason(
    p_workspace_id, p_operator_account_id, p_actor_did, p_subject_did);
  if v_protection is not null then
    refused_reason := 'protected';
    protected_reason := v_protection;
    return next; return;
  end if;

  -- ── An existing row for THIS member.
  select * into v_existing
    from public.bluesky_relationship_actions
   where campaign_id = p_campaign_id
     and campaign_member_id = p_member_id
     and status <> 'skipped'
   for update;

  if v_existing.id is not null then
    action_id := v_existing.id;
    existing_status := v_existing.status;

    if v_existing.status in ('succeeded', 'failed', 'reconciliation_required') then
      terminal := true; return next; return;
    end if;

    -- pending / running: a deleteRecord MAY already have been issued
    -- under this row. Reconciliation ONLY.
    --
    -- deleteRecord is idempotent, which makes a blind retry look safe —
    -- and it is not. Between the first request and the retry the
    -- operator may have re-followed, minting a NEW record under a new
    -- rkey; the retry would then delete a follow the operator wanted.
    -- So the rule is the same as the follow path's: read truth, never
    -- re-send.
    needs_reconcile := true;
    update public.bluesky_relationship_actions
       set status = 'running', started_at = coalesce(started_at, now())
     where id = v_existing.id;
    return next; return;
  end if;

  -- ── A record key is REQUIRED, and must have come from the provider.
  if p_record_rkey is null or length(btrim(p_record_rkey)) = 0 then
    refused_reason := 'no_record_key'; return next; return;
  end if;

  -- The URI must name THIS repository and the follow collection. A
  -- record in another repo is not ours to delete, and a record in
  -- another collection is not a follow at all — deleting one would
  -- remove a like, a post or a block.
  if p_record_uri is not null and length(btrim(p_record_uri)) > 0 then
    if p_record_uri <> 'at://' || p_actor_did || '/app.bsky.graph.follow/' || p_record_rkey then
      refused_reason := 'record_uri_mismatch'; return next; return;
    end if;
  end if;

  insert into public.bluesky_relationship_actions (
    workspace_id, operator_account_id, candidate_id, batch_id,
    action_type, subject_did, subject_handle_at_action,
    actor_did, actor_handle_at_action, status,
    follow_uri, follow_rkey, follow_cid,
    source_target_profile_ids, initiated_by, initiator_kind,
    campaign_id, campaign_run_id, campaign_member_id,
    started_at
  )
  values (
    p_workspace_id, p_operator_account_id, null, null,
    'unfollow', p_subject_did, p_subject_handle,
    p_actor_did, p_actor_handle, 'running',
    p_record_uri, p_record_rkey, p_record_cid,
    '{}', p_initiated_by, 'operator_batch',
    p_campaign_id, p_run_id, p_member_id,
    now()
  )
  returning id into v_id;

  -- NOTE what is deliberately absent: `provider_in_flight_at`.
  --
  -- The follow version stamps it here, which conflates "a worker
  -- intends to handle this member" with "a request is in flight" —
  -- exactly the conflation 20260911000005 had to unpick, because a
  -- crash between claiming and sending then silenced the member
  -- forever. The marker goes up in `consume_bluesky_member_quota`, one
  -- statement before the request, and nowhere else.
  action_id := v_id;
  may_mutate := true;
  return next;
exception
  when unique_violation then
    select * into v_existing
      from public.bluesky_relationship_actions
     where campaign_id = p_campaign_id
       and campaign_member_id = p_member_id
       and status <> 'skipped';

    if v_existing.id is null then
      -- The total conflict index. Something else holds the only
      -- unresolved intention for this (identity, subject): a Follow
      -- campaign, or a manual action. FAIL CLOSED and name it.
      refused_reason := 'conflicting_intent';
      return next; return;
    end if;

    action_id := v_existing.id;
    existing_status := v_existing.status;
    needs_reconcile := v_existing.status not in
      ('succeeded', 'failed', 'reconciliation_required');
    terminal := not needs_reconcile;
    return next;
end;
$$;

comment on function public.claim_bluesky_unfollow_action is
  'Create or take over the audit row for one unfollow, re-check '
  'protection, refuse a contested subject, and persist the EXACT '
  'record URI/rkey/cid before anything is sent. Never stamps provider '
  'intent: that happens one statement before the request, in '
  'consume_bluesky_member_quota.';

revoke all on function public.claim_bluesky_unfollow_action(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_bluesky_unfollow_action(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, uuid)
  to service_role;

-- =====================================================================
-- 11. Folding outcomes, per campaign kind
-- =====================================================================
--
-- `fold_bluesky_ledger_outcomes` is reached from BOTH settlement
-- (`apply_bluesky_run_outcome`) and the crash sweep
-- (`sweep_bluesky_quota_reservations`). Giving Unfollow a separate fold
-- would mean making the sweep kind-aware too, and a sweep that picks
-- the wrong fold is a sweep that mis-counts a public act. One entry
-- point, branching on the campaign's kind, is the smaller surface.
--
-- THE FOLLOW BRANCH IS REPRODUCED VERBATIM from 20260911000005,
-- including its classification, its counters and its comments. A test
-- folds a follow reservation and asserts the counters are identical to
-- the deployed behaviour, so drift in this copy is caught rather than
-- discovered in production.
--
-- WHY THE UNFOLLOW BRANCH CANNOT SHARE THE FOLLOW CLASSIFIER
-- ---------------------------------------------------------
-- The follow classifier reads `succeeded` + a non-null `follow_uri` as
-- "a record was created" and adds it to `follows_created`. For an
-- unfollow the same two facts mean a record was DESTROYED. Sharing the
-- branch would have every completed unfollow inflate the identity's
-- follow count, shrinking the account's follow ceiling by three points
-- for each person it stopped following.

create or replace function public.fold_bluesky_ledger_outcomes(
  p_reservation_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_usage_id uuid;
  v_kind text;
  v_succeeded integer := 0;
  v_already integer := 0;
  v_failed integer := 0;
  v_skipped integer := 0;
  v_unresolved integer := 0;
  v_records integer := 0;
  v_intents integer := 0;
  v_folded integer := 0;
begin
  select r.run_id, u.id, c.kind
    into v_run_id, v_usage_id, v_kind
    from public.bluesky_campaign_quota_reservations r
    left join public.bluesky_identity_daily_usage u
      on u.workspace_id = r.workspace_id
     and u.operator_account_id = r.operator_account_id
     and u.usage_date = r.usage_date
    left join public.bluesky_follow_campaigns c
      on c.id = r.campaign_id
   where r.id = p_reservation_id;

  if v_run_id is null then
    return 0;
  end if;

  -- Same global order as everything else: usage, then run, then the
  -- ledger rows. Re-acquiring a lock a caller already holds is free.
  if v_usage_id is not null then
    perform 1 from public.bluesky_identity_daily_usage
      where id = v_usage_id for update;
  end if;
  perform 1 from public.bluesky_follow_campaign_runs
    where id = v_run_id for update;

  with pending as (
    select l.id, l.member_id, l.campaign_id, l.action_id, l.provider_intent_at
      from public.bluesky_campaign_attempt_ledger l
     where l.reservation_id = p_reservation_id
       and l.counted_at is null
       for update
  ),
  resolved as (
    select p.id,
           p.provider_intent_at,
           coalesce(named.status, legacy.status) as action_status,
           coalesce(named.follow_uri, legacy.follow_uri) as follow_uri
      from pending p
      -- The action this attempt actually paid for.
      left join public.bluesky_relationship_actions named
        on named.id = p.action_id
      -- Legacy rows only, and at most ONE of them.
      left join lateral (
        select a.status, a.follow_uri
          from public.bluesky_relationship_actions a
         where p.action_id is null
           and a.campaign_member_id = p.member_id
           and a.campaign_id = p.campaign_id
         order by (a.status <> 'skipped') desc, a.created_at desc, a.id
         limit 1
      ) legacy on true
  ),
  classified as (
    select id,
           provider_intent_at,
           case
             -- FOLLOW: a succeeded action WITHOUT a follow record is
             -- the already-following path — observed, not created, and
             -- no provider budget was spent.
             --
             -- UNFOLLOW: the same two facts mean the opposite. A
             -- succeeded action WITH a record uri deleted that record;
             -- one WITHOUT means the follow was already absent when the
             -- run reached it, which is a neutral success costing
             -- nothing.
             when action_status = 'succeeded' and follow_uri is not null
               then 'succeeded'
             when action_status = 'succeeded' then 'already_in_state'
             when action_status = 'failed' then 'failed'
             when action_status = 'skipped' then 'skipped'
             -- reconciliation_required, still running, or no action at
             -- all. UNKNOWN: counted as no outcome, but its unit was
             -- spent at provider intent and is never returned.
             else 'unknown'
           end as outcome
      from resolved
  ),
  counted as (
    update public.bluesky_campaign_attempt_ledger l
       set counted_at = now()
      from classified c
     where l.id = c.id
     returning c.outcome, c.provider_intent_at
  )
  select
    count(*) filter (where outcome = 'succeeded')::int,
    count(*) filter (where outcome = 'already_in_state')::int,
    count(*) filter (where outcome = 'failed')::int,
    count(*) filter (where outcome = 'skipped')::int,
    count(*) filter (where outcome = 'unknown')::int,
    count(*) filter (where outcome = 'succeeded')::int,
    count(*) filter (where provider_intent_at is not null)::int,
    count(*)::int
  into v_succeeded, v_already, v_failed, v_skipped, v_unresolved,
       v_records, v_intents, v_folded
  from counted;

  if v_folded = 0 then
    return 0;
  end if;

  -- `attempted_count` is NOT touched here. It was incremented at
  -- provider intent, one member at a time, which is why attempts
  -- survive a crash.
  if v_kind = 'unfollow' then
    update public.bluesky_follow_campaign_runs
       set succeeded_count      = succeeded_count + v_succeeded,
           already_absent_count = already_absent_count + v_already,
           failed_count         = failed_count + v_failed,
           skipped_count        = skipped_count + v_skipped,
           reconciliation_required_count =
             reconciliation_required_count + v_unresolved,
           last_chunk_at        = now()
     where id = v_run_id;

    if v_usage_id is not null then
      -- DELETES, never `follows_created`. The identity's follow count
      -- must not rise because it stopped following someone.
      update public.bluesky_identity_daily_usage
         set unfollows_deleted    = unfollows_deleted + v_records,
             delete_attempts_made = delete_attempts_made + v_intents,
             updated_at = now()
       where id = v_usage_id;
    end if;
  else
    update public.bluesky_follow_campaign_runs
       set succeeded_count = succeeded_count + v_succeeded,
           already_following_count = already_following_count + v_already,
           failed_count = failed_count + v_failed,
           skipped_count = skipped_count + v_skipped,
           last_chunk_at = now()
     where id = v_run_id;

    if v_usage_id is not null then
      update public.bluesky_identity_daily_usage
         set follows_created = follows_created + v_records,
             updated_at = now()
       where id = v_usage_id;
    end if;
  end if;

  return v_folded;
end;
$$;

revoke all on function public.fold_bluesky_ledger_outcomes(uuid)
  from public, anon, authenticated;
grant execute on function public.fold_bluesky_ledger_outcomes(uuid)
  to service_role;

-- =====================================================================
-- 12. Sources for an unfollow queue
-- =====================================================================
--
-- Four scopes, and NEVER a combination. `bluesky_campaign_import_jobs`
-- is already `unique (campaign_id)` and already refuses a source change
-- on an existing job, so "one campaign, one source" is enforced by the
-- schema rather than by the wizard.

do $$
begin
  alter table public.bluesky_campaign_import_jobs
    drop constraint if exists bluesky_campaign_import_jobs_source_kind_check;
  alter table public.bluesky_campaign_import_jobs
    add constraint bluesky_campaign_import_jobs_source_kind_check
    check (source_kind in (
      'candidates',         -- follow: the eligible candidate corpus
      'target_followers',   -- follow/unfollow: one imported list
      'following_records',  -- unfollow: everyone this account follows,
                            -- walked from the acting REPOSITORY itself
      'follow_campaign',    -- unfollow: profiles a Signal follow
                            -- campaign actually followed
      'filtered_candidates' -- unfollow: the operator's current filter
    ));
end;
$$;

-- Which follow campaign a `follow_campaign` source names.
alter table public.bluesky_campaign_import_jobs
  add column if not exists source_campaign_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'bluesky_import_jobs_source_campaign_tenant_fk'
  ) then
    alter table public.bluesky_campaign_import_jobs
      add constraint bluesky_import_jobs_source_campaign_tenant_fk
      foreign key (source_campaign_id, workspace_id)
      references public.bluesky_follow_campaigns (id, workspace_id)
      on delete cascade;
  end if;
end;
$$;

comment on column public.bluesky_campaign_import_jobs.source_campaign_id is
  'The Signal follow campaign whose successful follows are this '
  'unfollow queue. A composite FK, so it cannot name another '
  'workspace''s campaign.';

-- ── Reading a source by KEYSET ───────────────────────────────────────
--
-- Ordered by `subject_did` alone. That is a TOTAL order with its own
-- unique tie-breaker — a DID is unique within every source here — so
-- there is no second sort column to get wrong and no pair of rows that
-- can tie. It is also STABLE under mutation in a way a timestamp is
-- not: a DID does not change, so a row cannot move across the cursor
-- while the walk is in progress and be read twice or skipped.
--
-- There is NO OFFSET. `where subject_did > cursor order by subject_did
-- limit n` costs the same at row 1 and row 100,000, and cannot skip a
-- row when an earlier one changes.

create or replace function public.list_bluesky_unfollow_source_keyset(
  p_workspace_id uuid,
  p_operator_account_id uuid,
  p_source_kind text,
  p_target_profile_id uuid,
  p_source_campaign_id uuid,
  p_after_did text,
  p_limit integer
)
returns table (
  subject_did text,
  current_handle text,
  display_name text,
  record_uri text,
  record_rkey text,
  record_cid text
)
language sql
stable
security definer
set search_path = public
as $$
  -- Candidates this identity currently believes it follows.
  --
  -- `relationship_state` is a local BELIEF, and `unknown` is excluded
  -- deliberately: queueing an unknown would be asserting a relationship
  -- nobody observed. The worker re-reads truth before acting anyway, so
  -- a stale `following` costs one neutral `already_not_following` —
  -- whereas a stale `unknown` that is really a follow simply never gets
  -- unfollowed, which the operator can see and fix.
  select c.subject_did, c.handle, c.display_name,
         c.follow_uri, c.follow_rkey, c.follow_cid
    from public.bluesky_candidates c
   where p_source_kind in ('candidates', 'filtered_candidates')
     and c.workspace_id = p_workspace_id
     and c.operator_account_id = p_operator_account_id
     and c.relationship_state in ('following', 'mutual')
     and (p_after_did is null or c.subject_did > p_after_did)

  union all

  -- One imported list: the candidates discovered from one target.
  select c.subject_did, c.handle, c.display_name,
         c.follow_uri, c.follow_rkey, c.follow_cid
    from public.bluesky_candidates c
    join public.bluesky_candidate_sources s on s.candidate_id = c.id
   where p_source_kind = 'target_followers'
     and c.workspace_id = p_workspace_id
     and c.operator_account_id = p_operator_account_id
     and s.target_profile_id = p_target_profile_id
     and c.relationship_state in ('following', 'mutual')
     and (p_after_did is null or c.subject_did > p_after_did)

  union all

  -- Profiles a Signal follow campaign ACTUALLY followed.
  --
  -- `succeeded` only. `already_following` members were never followed
  -- by that campaign — it found them already followed — so including
  -- them would quietly widen "undo this campaign" into "unfollow
  -- everyone it looked at".
  select m.subject_did, m.current_handle, m.display_name,
         m.provider_record_uri, m.provider_record_rkey, m.provider_record_cid
    from public.bluesky_follow_campaign_members m
   where p_source_kind = 'follow_campaign'
     and m.workspace_id = p_workspace_id
     and m.campaign_id = p_source_campaign_id
     and m.status = 'succeeded'
     and (p_after_did is null or m.subject_did > p_after_did)

  order by 1
  limit least(greatest(coalesce(p_limit, 1), 1), 1000);
$$;

comment on function public.list_bluesky_unfollow_source_keyset is
  'One page of an unfollow source, by keyset on subject_did — a total '
  'order whose tie-breaker is the key itself, so no two rows can tie '
  'and no row can move across the cursor mid-walk. Never OFFSET.';

revoke all on function public.list_bluesky_unfollow_source_keyset(
  uuid, uuid, text, uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.list_bluesky_unfollow_source_keyset(
  uuid, uuid, text, uuid, uuid, text, integer)
  to service_role;

-- Counting a source WITHOUT reading it, so the confirmation screen can
-- show an exact number for a 100,000-row list.
create or replace function public.count_bluesky_unfollow_source(
  p_workspace_id uuid,
  p_operator_account_id uuid,
  p_actor_did text,
  p_source_kind text,
  p_target_profile_id uuid,
  p_source_campaign_id uuid
)
returns table (eligible integer, protected_excluded integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  with source as (
    select s.subject_did
      from public.list_bluesky_unfollow_source_keyset(
        p_workspace_id, p_operator_account_id, p_source_kind,
        p_target_profile_id, p_source_campaign_id, null, 1000000) s
  ),
  marked as (
    select s.subject_did,
           public.bluesky_unfollow_protection_reason(
             p_workspace_id, p_operator_account_id, p_actor_did, s.subject_did
           ) as reason
      from source s
  )
  select count(*) filter (where reason is null)::int,
         count(*) filter (where reason is not null)::int
    into eligible, protected_excluded
    from marked;
  return next;
end;
$$;

revoke all on function public.count_bluesky_unfollow_source(
  uuid, uuid, text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.count_bluesky_unfollow_source(
  uuid, uuid, text, text, uuid, uuid)
  to service_role;

-- =====================================================================
-- 13. Importing one bounded chunk into the frozen queue
-- =====================================================================
--
-- The unfollow sibling of `import_bluesky_campaign_member_chunk`. Two
-- differences, both load-bearing:
--
--   1. It carries the follow-record identity (uri, rkey, cid) onto the
--      member row, tagged with WHERE it was read from. Without that the
--      queue would hold 100,000 DIDs and no way to delete any of them
--      except by guessing a record key, which is the one thing this
--      subsystem must never do.
--
--   2. It applies protection AT IMPORT, so a protected profile is
--      visible as excluded on the confirmation screen rather than
--      discovered silently at 09:00 tomorrow. This is the FIRST of two
--      checks; `claim_bluesky_unfollow_action` runs the same function
--      again inside the transaction that creates the action row,
--      because an operator may protect someone after the queue froze.
--
-- CONCURRENT BUILDERS may duplicate internal work — two invocations may
-- read the same page — but cannot duplicate a member: the campaign row
-- is locked for the sequence allocation, and `unique (campaign_id,
-- subject_did)` with `on conflict do nothing` absorbs the overlap.

create or replace function public.import_bluesky_unfollow_member_chunk(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_operator_account_id uuid,
  p_actor_did text,
  p_members jsonb
)
returns table (
  out_inserted integer,
  out_duplicates integer,
  out_protected integer,
  out_last_did text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign_id uuid;
  v_kind text;
  v_status text;
  v_start bigint;
  v_valid integer;
  v_inserted integer;
  v_protected integer;
begin
  out_inserted := 0; out_duplicates := 0; out_protected := 0;

  -- Lock the campaign, not merely the job: the import_sequence
  -- allocation below is a read-then-write and two builders must not
  -- interleave it. Locking the campaign also serialises this against
  -- the follow import path, which feeds the same member table.
  select c.id, c.kind, c.status into v_campaign_id, v_kind, v_status
    from public.bluesky_follow_campaigns c
   where c.id = p_campaign_id
     and c.workspace_id = p_workspace_id
   for update;

  if v_campaign_id is null then return next; return; end if;

  if v_kind <> 'unfollow' then
    raise exception
      'import_bluesky_unfollow_member_chunk refuses campaign % of kind %',
      p_campaign_id, v_kind;
  end if;

  -- A RUNNING CAMPAIGN MUST NEVER SILENTLY WIDEN.
  --
  -- The frozen queue is the whole promise of the confirmation screen:
  -- the operator approved "these N people", and an import that landed
  -- afterwards would make that sentence false without anyone being
  -- asked again.
  if v_status not in ('draft', 'building_queue') then
    raise exception
      'campaign % is % — its queue is frozen and cannot take new members',
      p_campaign_id, v_status;
  end if;

  select coalesce(max(m.import_sequence), 0)
    into v_start
    from public.bluesky_follow_campaign_members m
   where m.campaign_id = p_campaign_id;

  with parsed as materialized (
    select distinct on (x.subject_did)
           x.subject_did,
           x.current_handle,
           x.display_name,
           nullif(btrim(x.record_uri), '')  as record_uri,
           nullif(btrim(x.record_rkey), '') as record_rkey,
           nullif(btrim(x.record_cid), '')  as record_cid,
           coalesce(nullif(x.record_source, ''), 'relationship_read') as record_source,
           public.bluesky_unfollow_protection_reason(
             p_workspace_id, p_operator_account_id, p_actor_did, x.subject_did
           ) as protection
      from jsonb_to_recordset(coalesce(p_members, '[]'::jsonb)) as x(
        subject_did text,
        current_handle text,
        display_name text,
        record_uri text,
        record_rkey text,
        record_cid text,
        record_source text
      )
     where x.subject_did like 'did:%'
     order by x.subject_did
  ), numbered as (
    select p.*,
           v_start + row_number() over (order by p.subject_did) as seq
      from parsed p
  ), inserted as (
    insert into public.bluesky_follow_campaign_members (
      workspace_id, campaign_id, subject_did, current_handle, display_name,
      import_sequence, status, protected_reason,
      provider_record_uri, provider_record_rkey, provider_record_cid,
      provider_record_source, completed_at
    )
    select p_workspace_id, p_campaign_id, n.subject_did,
           n.current_handle, n.display_name, n.seq,
           case when n.protection is null then 'queued' else 'protected' end,
           n.protection,
           n.record_uri, n.record_rkey, n.record_cid,
           case when n.record_rkey is null then null else n.record_source end,
           case when n.protection is null then null else now() end
      from numbered n
    on conflict (campaign_id, subject_did) do nothing
    returning id, status
  )
  select (select count(*) from parsed)::int,
         (select count(*) from inserted)::int,
         (select count(*) from inserted where status = 'protected')::int
    into v_valid, v_inserted, v_protected;

  -- Attribution, for both newly inserted and already-present members.
  with parsed as materialized (
    select distinct on (x.subject_did) x.subject_did
      from jsonb_to_recordset(coalesce(p_members, '[]'::jsonb)) as x(subject_did text)
     where x.subject_did like 'did:%'
     order by x.subject_did
  )
  insert into public.bluesky_campaign_member_sources (
    workspace_id, member_id, target_profile_id, source_label
  )
  select p_workspace_id, m.id, null, 'unfollow_import'
    from parsed p
    join public.bluesky_follow_campaign_members m
      on m.campaign_id = p_campaign_id
     and m.subject_did = p.subject_did
  on conflict do nothing;

  out_inserted := coalesce(v_inserted, 0);
  out_protected := coalesce(v_protected, 0);
  out_duplicates := greatest(coalesce(v_valid, 0) - out_inserted, 0);

  -- The cursor the caller continues from: the LAST DID in the page it
  -- supplied, whether or not it was inserted. Advancing only past
  -- inserted rows would loop forever on a page that was entirely
  -- duplicates.
  select max(x.subject_did) into out_last_did
    from jsonb_to_recordset(coalesce(p_members, '[]'::jsonb)) as x(subject_did text)
   where x.subject_did like 'did:%';

  return next;
end;
$$;

revoke all on function public.import_bluesky_unfollow_member_chunk(
  uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.import_bluesky_unfollow_member_chunk(
  uuid, uuid, uuid, text, jsonb)
  to service_role;

-- =====================================================================
-- 14. Cancelling future work — without touching what already happened
-- =====================================================================
--
-- "Cancel future work" stops new claims. It does NOT re-follow anyone,
-- it does not rewrite a single action row, and it does not pretend the
-- campaign never ran. Members that are already terminal keep the state
-- they reached; only work that has not started is withdrawn.
--
-- Members with an outstanding provider intent are deliberately LEFT
-- ALONE. Their outcome is genuinely unknown, and marking them
-- `cancelled` would record that nothing happened to a person something
-- may well have happened to.

create or replace function public.cancel_bluesky_campaign_future_work(
  p_workspace_id uuid,
  p_campaign_id uuid
)
returns table (cancelled_members integer, left_unresolved integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cancelled integer;
  v_unresolved integer;
begin
  update public.bluesky_follow_campaign_members m
     set status = 'cancelled',
         completed_at = now(),
         claimed_at = null,
         claimed_by = null,
         lease_expires_at = null,
         next_attempt_at = null
   where m.workspace_id = p_workspace_id
     and m.campaign_id = p_campaign_id
     and m.status in ('queued', 'claimed', 'retryable')
     and not exists (
       select 1 from public.bluesky_campaign_attempt_ledger l
        where l.member_id = m.id
          and l.provider_intent_at is not null
     );
  get diagnostics v_cancelled = row_count;

  select count(*)::int into v_unresolved
    from public.bluesky_follow_campaign_members m
   where m.workspace_id = p_workspace_id
     and m.campaign_id = p_campaign_id
     and m.status not in (
       'succeeded', 'already_following', 'already_not_following',
       'protected', 'skipped', 'failed_structural', 'cancelled'
     );

  update public.bluesky_follow_campaigns
     set status = 'cancelled', cancelled_at = now(), next_run_at = null
   where id = p_campaign_id
     and workspace_id = p_workspace_id
     and status <> 'cancelled';

  cancelled_members := v_cancelled;
  left_unresolved := v_unresolved;
  return next;
end;
$$;

comment on function public.cancel_bluesky_campaign_future_work is
  'Withdraw work that has not started. Never re-follows, never rewrites '
  'history, and never marks a member with outstanding provider intent '
  'as cancelled — that member''s outcome is unknown, not absent.';

revoke all on function public.cancel_bluesky_campaign_future_work(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_bluesky_campaign_future_work(uuid, uuid)
  to service_role;

-- =====================================================================
-- 15. Recording "already not following" — the neutral success
-- =====================================================================
--
-- A member the provider reports as NOT followed. No record exists, so
-- no delete is sent and no unit of quota is spent — the requirement is
-- explicit about the second part, and the first is why.
--
-- WHY THIS IS AN RPC AND NOT JUST A MEMBER UPDATE
-- -----------------------------------------------
-- The audit row still has to be settled, and that is the whole point.
-- A worker killed mid-delete leaves an action marked in flight. If the
-- next pass short-circuits on "already not following" and never touches
-- that row, it sits `running` with its in-flight marker forever: the
-- member looks finished while History says a public request is still
-- outstanding, and the sweep keeps its quota held against a day that
-- has already moved on. So this path finalises the row rather than
-- stepping around it.
--
-- `follow_uri` is left NULL, which is exactly how
-- `fold_bluesky_ledger_outcomes` tells "a record was destroyed" from
-- "there was nothing to destroy".
--
-- Protection is checked FIRST. A protected profile that also happens to
-- be unfollowed already is recorded as protected, because that is the
-- honest reason Signal will not act on it — and it stays true if the
-- operator follows them again tomorrow.

create or replace function public.record_bluesky_unfollow_already_absent(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_run_id uuid,
  p_member_id uuid,
  p_operator_account_id uuid,
  p_subject_did text,
  p_subject_handle text,
  p_actor_did text,
  p_actor_handle text,
  p_initiated_by uuid,
  p_note text
)
returns table (
  recorded text,        -- 'already_not_following' | 'protected' | 'refused'
  protected_reason text,
  refused_reason text,
  action_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_protection text;
  v_existing public.bluesky_relationship_actions;
  v_id uuid;
begin
  select c.kind into v_kind
    from public.bluesky_follow_campaigns c
   where c.id = p_campaign_id and c.workspace_id = p_workspace_id;

  if v_kind is null then
    recorded := 'refused'; refused_reason := 'unknown_campaign';
    return next; return;
  elsif v_kind <> 'unfollow' then
    raise exception
      'record_bluesky_unfollow_already_absent refuses campaign % of kind %',
      p_campaign_id, v_kind;
  end if;

  v_protection := public.bluesky_unfollow_protection_reason(
    p_workspace_id, p_operator_account_id, p_actor_did, p_subject_did);

  select * into v_existing
    from public.bluesky_relationship_actions
   where campaign_id = p_campaign_id
     and campaign_member_id = p_member_id
     and status <> 'skipped'
   for update;

  if v_protection is not null then
    -- A protected member should never have had an action row. If one
    -- exists it is from a worker that died before protection was added,
    -- and it is finalised as `skipped` so nothing stays in flight.
    if v_existing.id is not null
       and v_existing.status not in ('succeeded', 'failed') then
      update public.bluesky_relationship_actions
         set status = 'skipped',
             provider_in_flight_at = null,
             finished_at = now(),
             reconciliation_note = 'Protected from automatic unfollowing. Nothing was sent.'
       where id = v_existing.id;
    end if;

    update public.bluesky_follow_campaign_members
       set status = 'protected',
           protected_reason = v_protection,
           completed_at = now(),
           claimed_at = null, claimed_by = null, lease_expires_at = null
     where id = p_member_id and workspace_id = p_workspace_id;

    recorded := 'protected'; protected_reason := v_protection;
    action_id := v_existing.id;
    return next; return;
  end if;

  if v_existing.id is not null then
    action_id := v_existing.id;
    if v_existing.status not in ('succeeded', 'failed') then
      update public.bluesky_relationship_actions
         set status = 'succeeded',
             -- NULL, deliberately: nothing was deleted.
             follow_uri = null,
             provider_in_flight_at = null,
             finished_at = now(),
             reconciled_state = 'not_following',
             reconciled_at = now(),
             reconciliation_note = coalesce(p_note,
               'Bluesky reports this account is not followed, so no follow record was deleted and no quota was used.')
       where id = v_existing.id;
    end if;
  else
    insert into public.bluesky_relationship_actions (
      workspace_id, operator_account_id, action_type,
      subject_did, subject_handle_at_action,
      actor_did, actor_handle_at_action, status,
      source_target_profile_ids, initiated_by, initiator_kind,
      campaign_id, campaign_run_id, campaign_member_id,
      started_at, finished_at, reconciled_state, reconciled_at,
      reconciliation_note
    )
    values (
      p_workspace_id, p_operator_account_id, 'unfollow',
      p_subject_did, p_subject_handle,
      p_actor_did, p_actor_handle, 'succeeded',
      '{}', p_initiated_by, 'operator_batch',
      p_campaign_id, p_run_id, p_member_id,
      now(), now(), 'not_following', now(),
      coalesce(p_note,
        'Bluesky reports this account is not followed, so no follow record was deleted and no quota was used.')
    )
    returning id into v_id;
    action_id := v_id;
  end if;

  update public.bluesky_follow_campaign_members
     set status = 'already_not_following',
         completed_at = now(),
         claimed_at = null, claimed_by = null, lease_expires_at = null,
         last_error_code = null, last_error_message = null
   where id = p_member_id and workspace_id = p_workspace_id;

  recorded := 'already_not_following';
  return next;
end;
$$;

revoke all on function public.record_bluesky_unfollow_already_absent(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_bluesky_unfollow_already_absent(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, uuid, text)
  to service_role;

-- =====================================================================
-- 16. Opening and advancing an UNFOLLOW queue build
-- =====================================================================
--
-- The unfollow cursor space is `subject_did` alone, so this is a
-- separate function rather than a changed signature on a deployed one.
--
-- THE CURSOR ONLY EVER MOVES FORWARD. Two builders that overlap may
-- both read the same page — wasted work, which is fine — but neither
-- can move the cursor BACKWARD, so no row can be skipped by a late
-- commit landing after an earlier one.
--
-- The campaign's own status is moved here too, so `building_queue` and
-- `ready` are properties of the campaign an operator can see, not
-- something they have to infer from a job row.

create or replace function public.begin_bluesky_unfollow_import(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_source_kind text,
  p_target_profile_id uuid,
  p_source_campaign_id uuid
)
-- OUT names are prefixed because plpgsql cannot tell a parameter from a
-- column of the same name inside an UPDATE, and rejects the statement
-- as ambiguous only when the function is CALLED.
returns table (
  out_job_id uuid,
  out_status text,
  out_source_kind text,
  out_target_profile_id uuid,
  out_source_campaign_id uuid,
  out_cursor_did text,
  out_provider_cursor text,
  out_source_exhausted boolean,
  out_imported integer,
  out_duplicates integer,
  out_excluded integer,
  out_refused_reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.bluesky_campaign_import_jobs;
  v_kind text;
  v_status text;
begin
  select c.kind, c.status into v_kind, v_status
    from public.bluesky_follow_campaigns c
   where c.id = p_campaign_id and c.workspace_id = p_workspace_id
   for update;

  if v_kind is null then
    out_refused_reason := 'unknown_campaign'; return next; return;
  elsif v_kind <> 'unfollow' then
    out_refused_reason := 'wrong_campaign_kind'; return next; return;
  elsif v_status not in ('draft', 'building_queue') then
    -- A campaign past the build phase has a FROZEN queue. Reopening the
    -- build is how a running campaign silently widens, which would make
    -- the sentence the operator approved — "these N profiles" — false
    -- without anyone being asked again.
    out_refused_reason := 'queue_frozen'; return next; return;
  end if;

  select * into v_job
    from public.bluesky_campaign_import_jobs
   where campaign_id = p_campaign_id
     for update;

  if v_job.id is null then
    insert into public.bluesky_campaign_import_jobs (
      workspace_id, campaign_id, source_kind, target_profile_id,
      source_campaign_id
    )
    values (p_workspace_id, p_campaign_id, p_source_kind,
            p_target_profile_id, p_source_campaign_id)
    returning * into v_job;
  elsif v_job.workspace_id <> p_workspace_id then
    out_refused_reason := 'workspace_mismatch'; return next; return;
  elsif v_job.source_kind <> p_source_kind
     or v_job.target_profile_id is distinct from p_target_profile_id
     or v_job.source_campaign_id is distinct from p_source_campaign_id then
    -- SOURCE IMMUTABILITY. A queue half-built from one list and half
    -- from another is not something an operator can reason about, and
    -- the campaign's whole promise is "these profiles".
    out_refused_reason := 'source_locked'; return next; return;
  end if;

  if v_status = 'draft' then
    update public.bluesky_follow_campaigns
       set status = 'building_queue'
     where id = p_campaign_id and status = 'draft';
  end if;

  out_job_id := v_job.id;
  out_status := v_job.status;
  out_source_kind := v_job.source_kind;
  out_target_profile_id := v_job.target_profile_id;
  out_source_campaign_id := v_job.source_campaign_id;
  out_cursor_did := v_job.cursor_subject_did;
  out_provider_cursor := v_job.provider_cursor;
  out_source_exhausted := v_job.source_exhausted;
  out_imported := v_job.imported_count;
  out_duplicates := v_job.duplicate_count;
  out_excluded := v_job.excluded_count;
  return next;
end;
$$;

revoke all on function public.begin_bluesky_unfollow_import(
  uuid, uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.begin_bluesky_unfollow_import(
  uuid, uuid, text, uuid, uuid) to service_role;

create or replace function public.advance_bluesky_unfollow_import(
  p_workspace_id uuid,
  p_job_id uuid,
  p_cursor_subject_did text,
  p_provider_cursor text,
  p_inserted integer,
  p_duplicates integer,
  p_excluded integer,
  p_pages integer,
  p_source_exhausted boolean,
  p_error text
)
returns table (
  out_status text,
  out_cursor_did text,
  out_provider_cursor text,
  out_source_exhausted boolean,
  out_imported integer,
  out_duplicates integer,
  out_excluded integer,
  out_campaign_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.bluesky_campaign_import_jobs;
  v_advance boolean;
  v_campaign_status text;
begin
  select * into v_job
    from public.bluesky_campaign_import_jobs j
   where j.id = p_job_id and j.workspace_id = p_workspace_id
   for update;

  if v_job.id is null then return; end if;

  -- FORWARD ONLY. Two overlapping builders duplicate work; neither may
  -- rewind the other's progress, because a rewind is how a row gets
  -- read twice and a late commit is how one gets skipped.
  v_advance := p_cursor_subject_did is not null
    and (v_job.cursor_subject_did is null
         or p_cursor_subject_did > v_job.cursor_subject_did);

  update public.bluesky_campaign_import_jobs j
     set cursor_subject_did = case when v_advance then p_cursor_subject_did
                                   else j.cursor_subject_did end,
         provider_cursor = case
           when coalesce(p_source_exhausted, false) then null
           when p_provider_cursor is not null then p_provider_cursor
           else j.provider_cursor
         end,
         imported_count  = j.imported_count + greatest(coalesce(p_inserted, 0), 0),
         duplicate_count = j.duplicate_count + greatest(coalesce(p_duplicates, 0), 0),
         excluded_count  = j.excluded_count + greatest(coalesce(p_excluded, 0), 0),
         pages_read      = j.pages_read + greatest(coalesce(p_pages, 0), 0),
         source_exhausted = j.source_exhausted or coalesce(p_source_exhausted, false),
         last_error = p_error,
         status = case
           when p_error is not null then 'failed'
           when j.source_exhausted or coalesce(p_source_exhausted, false) then 'ready'
           else 'running'
         end
   where j.id = p_job_id
   returning * into v_job;

  -- The campaign follows the job, and ONLY from the build states. A
  -- late import callback must never move an active campaign back to
  -- `ready`, or a cancelled one anywhere at all.
  update public.bluesky_follow_campaigns c
     set status = case
           when v_job.status = 'ready' then 'ready'
           when v_job.status = 'failed' then 'failed'
           else 'building_queue'
         end,
         last_error_message = case
           when v_job.status = 'failed' then p_error
           else c.last_error_message
         end
   where c.id = v_job.campaign_id
     and c.workspace_id = p_workspace_id
     and c.status in ('draft', 'building_queue', 'ready')
  returning c.status into v_campaign_status;

  if v_campaign_status is null then
    select c.status into v_campaign_status
      from public.bluesky_follow_campaigns c where c.id = v_job.campaign_id;
  end if;

  out_status := v_job.status;
  out_cursor_did := v_job.cursor_subject_did;
  out_provider_cursor := v_job.provider_cursor;
  out_source_exhausted := v_job.source_exhausted;
  out_imported := v_job.imported_count;
  out_duplicates := v_job.duplicate_count;
  out_excluded := v_job.excluded_count;
  out_campaign_status := v_campaign_status;
  return next;
end;
$$;

revoke all on function public.advance_bluesky_unfollow_import(
  uuid, uuid, text, text, integer, integer, integer, integer, boolean, text)
  from public, anon, authenticated;
grant execute on function public.advance_bluesky_unfollow_import(
  uuid, uuid, text, text, integer, integer, integer, integer, boolean, text)
  to service_role;

-- =====================================================================
-- 17. Deferring a member IN THE DATABASE'S OWN CLOCK
-- =====================================================================
--
-- `next_attempt_at` is not a record of when something happened. It is
-- one side of a COMPARISON that `reserve_bluesky_campaign_quota`
-- performs — `next_attempt_at <= now()` — and `now()` there is
-- PostgreSQL's clock.
--
-- Writing the other side from the application's clock makes the
-- comparison depend on two clocks agreeing. They usually do, and the
-- failure when they do not is quiet and expensive: a backoff written
-- slightly in the past is no backoff at all, so an unresolved member
-- becomes eligible again immediately, is re-claimed for reconciliation
-- REGARDLESS of quota, and a dispatcher pass spends its whole budget
-- re-reading one profile while the queue behind it never moves.
--
-- This is the same rule the rest of the subsystem already follows for
-- leases and reservation expiry, applied to the one comparison that
-- had been left in application time. The caller sends a DURATION; the
-- database decides what instant that is.

create or replace function public.defer_bluesky_campaign_member(
  p_workspace_id uuid,
  p_member_id uuid,
  p_delay_seconds integer
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next timestamptz;
begin
  update public.bluesky_follow_campaign_members m
     set next_attempt_at = now()
       + make_interval(secs => greatest(coalesce(p_delay_seconds, 60), 1))
   where m.id = p_member_id
     and m.workspace_id = p_workspace_id
     -- Only a member that is actually waiting. Deferring a terminal row
     -- would give it a future date it will never be read at, which is
     -- merely confusing; deferring another worker's claimed row would
     -- be worse.
     and m.status = 'retryable'
  returning m.next_attempt_at into v_next;
  return v_next;
end;
$$;

revoke all on function public.defer_bluesky_campaign_member(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.defer_bluesky_campaign_member(uuid, uuid, integer)
  to service_role;
