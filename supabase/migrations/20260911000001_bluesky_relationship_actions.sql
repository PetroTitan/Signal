-- Bluesky relationship actions — schema.
--
-- Strictly ADDITIVE. No existing table, column, constraint, default or
-- policy is altered. Nothing here touches publishing: not
-- publish_history, not weekly_plan_items, not the scheduler. This is a
-- separate subsystem that happens to reuse the same workspace and the
-- same platform_connections session.
--
-- Five tables:
--
--   bluesky_target_profiles    a profile whose followers we import
--   bluesky_import_runs        one resumable pass over that profile's
--                              followers, holding the provider cursor
--   bluesky_candidates         one row per DISTINCT DID, ever
--   bluesky_candidate_sources  which target profiles a candidate came
--                              from (many-to-many, so attribution
--                              accumulates instead of overwriting)
--   bluesky_action_batches     an operator-confirmed set of mutations
--   bluesky_relationship_actions  one mutation, and its audit record
--
-- The identity rule, enforced by the database and not only by code:
-- `bluesky_candidates` is unique on (workspace_id, operator_account_id,
-- subject_did). There is no unique index on handle anywhere, and no
-- foreign key references a handle. A handle is metadata that gets
-- refreshed; it is never a key. The provider returns `handle.invalid`
-- for DIDs whose handle cannot be verified, so handles are not even
-- guaranteed well-formed.

set search_path = public;

-- =====================================================================
-- 1. Target profiles
-- =====================================================================
--
-- "Import the followers of @someone." The operator types a handle; we
-- resolve it once and then key everything off the DID, so a later
-- handle change does not create a second target or orphan the first.

create table if not exists public.bluesky_target_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- The operator identity (growth_accounts row) whose Bluesky session
  -- performs the imports and the mutations. Every candidate and every
  -- action is scoped to this, because "do I follow this DID?" is only
  -- meaningful relative to one operator account.
  operator_account_id uuid not null
    references public.growth_accounts(id) on delete cascade,

  -- Canonical identity. Resolved via com.atproto.identity.resolveHandle
  -- or app.bsky.actor.getProfile; never typed by the operator.
  subject_did text not null check (subject_did like 'did:%'),

  -- Metadata as last observed. Refreshed on every profile read. A
  -- handle change updates these columns and loses no history, because
  -- nothing references them.
  handle text,
  display_name text,
  avatar_url text,
  followers_count integer,

  -- What the operator typed, kept verbatim for the audit trail. If they
  -- entered an old handle, this records that they did.
  requested_identifier text not null,

  profile_fetched_at timestamptz,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One target per (operator identity, subject). Re-adding the same
  -- profile resumes the existing target rather than forking its import
  -- history.
  unique (workspace_id, operator_account_id, subject_did)
);

comment on table public.bluesky_target_profiles is
  'A Bluesky profile whose follower list an operator imports. Keyed by '
  'DID; handle is refreshable metadata and is never an identity.';

create index if not exists bluesky_target_profiles_ws_idx
  on public.bluesky_target_profiles (workspace_id, operator_account_id);

drop trigger if exists bluesky_target_profiles_touch
  on public.bluesky_target_profiles;
create trigger bluesky_target_profiles_touch
  before update on public.bluesky_target_profiles
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 2. Import runs
-- =====================================================================
--
-- One resumable pass over app.bsky.graph.getFollowers.
--
-- `cursor` is the provider's opaque continuation token, persisted after
-- every page so an interrupted import resumes exactly where it stopped
-- instead of restarting. It is NEVER synthesised: an invalid cursor
-- does not error on this API, it silently returns the wrong page, so a
-- locally-constructed cursor would corrupt an import without any signal.
--
-- `status = 'completed'` is reserved for ONE condition: the provider
-- returned a page with no cursor. Page size is not evidence — a
-- verified walk with limit=5 returned pages of 5, 3 and 4 while more
-- data remained. `cursor_exhausted` records that condition explicitly
-- so the completeness claim is auditable rather than inferred.

create table if not exists public.bluesky_import_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  target_profile_id uuid not null
    references public.bluesky_target_profiles(id) on delete cascade,

  status text not null default 'pending' check (status in (
    'pending',      -- created, no page fetched yet
    'running',      -- a page fetch is in flight
    'paused',       -- stopped safely; cursor is valid, resume is safe
    'completed',    -- the provider returned no cursor. Only then.
    'failed'        -- stopped on an error; cursor may still be valid
  )),

  -- Provider continuation token. NULL before the first page, and NULL
  -- again once exhausted — which is why `cursor_exhausted` is a
  -- separate boolean and not derived from this being null.
  cursor text,
  cursor_exhausted boolean not null default false,

  pages_fetched integer not null default 0,
  followers_seen integer not null default 0,
  candidates_created integer not null default 0,
  candidates_updated integer not null default 0,

  -- Why the run stopped, when it stopped for a reason worth showing:
  -- 'page_budget', 'rate_limited', 'provider_error', 'operator'.
  stop_reason text,
  last_error text,

  started_at timestamptz,
  finished_at timestamptz,

  started_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A run cannot claim completion while the cursor is unexhausted.
  -- This is the invariant that makes "import complete" trustworthy, and
  -- it is enforced here so no code path — not a bug, not a future
  -- refactor — can mark a partial import complete.
  constraint bluesky_import_runs_completion_requires_exhaustion
    check (status <> 'completed' or cursor_exhausted)
);

comment on constraint bluesky_import_runs_completion_requires_exhaustion
  on public.bluesky_import_runs is
  'An import is complete only when the provider stopped returning a '
  'cursor. Page size is not evidence of exhaustion: a verified walk '
  'with limit=5 returned 5, then 3, then 4 with more data remaining.';

create index if not exists bluesky_import_runs_target_idx
  on public.bluesky_import_runs (target_profile_id, created_at desc);

create index if not exists bluesky_import_runs_ws_status_idx
  on public.bluesky_import_runs (workspace_id, status);

drop trigger if exists bluesky_import_runs_touch on public.bluesky_import_runs;
create trigger bluesky_import_runs_touch
  before update on public.bluesky_import_runs
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 3. Candidates — one row per DID, forever
-- =====================================================================
--
-- The deduplicated corpus. A DID discovered from five target profiles
-- is ONE row here with five rows in bluesky_candidate_sources.
--
-- relationship_state is the local belief about the edge. `unknown` is a
-- first-class value and the DEFAULT: a candidate we have never checked,
-- and a candidate whose lookup failed, are both honestly unknown. A
-- provider failure must never be written here as 'not_following' —
-- that would assert an absence we did not observe.

create table if not exists public.bluesky_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  operator_account_id uuid not null
    references public.growth_accounts(id) on delete cascade,

  subject_did text not null check (subject_did like 'did:%'),

  -- Current metadata. Overwritten on every sighting; the DID never
  -- changes, so a handle change updates this column and keeps the row,
  -- its source attribution, and its entire action history intact.
  handle text,
  display_name text,
  avatar_url text,
  profile_refreshed_at timestamptz,

  first_discovered_at timestamptz not null default now(),
  last_discovered_at timestamptz not null default now(),

  relationship_state text not null default 'unknown' check (relationship_state in (
    'unknown',        -- never checked, or the check failed. Not a claim.
    'not_following',  -- observed: the provider returned a relationship
                      -- object with no `following` key
    'following',      -- we follow them
    'follows_you',    -- they follow us, we do not follow them
    'mutual'          -- both directions
  )),
  relationship_checked_at timestamptz,
  -- Set when the last relationship read FAILED, so the UI can say
  -- "unknown because the lookup failed" rather than implying we simply
  -- have not looked yet.
  relationship_error text,

  followed_at timestamptz,
  unfollowed_at timestamptz,

  -- Provider follow-record identity, captured from createRecord or from
  -- getRelationships().following. `rkey` is what deleteRecord needs.
  -- It is NEVER derived from subject_did: observed rkeys include both
  -- mangled DIDs ('did_plc_z72i...') and TIDs ('zP0yDDN2oUGcWA') in the
  -- same response, so any derivation rule is wrong for most rows.
  follow_uri text,
  follow_rkey text,
  -- CID of the follow record when we created it. getRelationships does
  -- not return a CID, so this stays null for reconciled follows. Used
  -- for deleteRecord's optional swapRecord compare-and-swap.
  follow_cid text,
  follow_record_source text check (follow_record_source is null
    or follow_record_source in ('create_record', 'reconciled')),

  -- Operator-set. Excluded from batch unfollow unconditionally.
  protected boolean not null default false,
  protected_at timestamptz,
  protected_by uuid references auth.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- THE identity constraint. One row per DID per operator identity.
  unique (workspace_id, operator_account_id, subject_did)
);

comment on table public.bluesky_candidates is
  'Deduplicated candidate corpus keyed by DID. One DID discovered from '
  'many target profiles is one row here plus many rows in '
  'bluesky_candidate_sources.';

comment on column public.bluesky_candidates.relationship_state is
  'Local belief about the edge. `unknown` is the default and a real '
  'state: a failed provider lookup stays unknown and is never recorded '
  'as not_following, which would assert an absence nobody observed.';

comment on column public.bluesky_candidates.follow_rkey is
  'Record key read from the provider, never computed. Observed rkeys '
  'use incompatible schemes (mangled DID vs TID) within one response.';

create index if not exists bluesky_candidates_ws_state_idx
  on public.bluesky_candidates (workspace_id, operator_account_id, relationship_state);

create index if not exists bluesky_candidates_protected_idx
  on public.bluesky_candidates (workspace_id, operator_account_id)
  where protected;

create index if not exists bluesky_candidates_discovered_idx
  on public.bluesky_candidates (workspace_id, operator_account_id, last_discovered_at desc);

drop trigger if exists bluesky_candidates_touch on public.bluesky_candidates;
create trigger bluesky_candidates_touch
  before update on public.bluesky_candidates
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 4. Candidate source attribution
-- =====================================================================
--
-- Why a separate table rather than an array column on the candidate:
-- an array gets read-modify-written, and two concurrent imports of
-- overlapping audiences will lose one of the two attributions. A row
-- per (candidate, target) with a unique constraint makes an
-- already-known source a no-op insert instead of a lost update.

create table if not exists public.bluesky_candidate_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  candidate_id uuid not null
    references public.bluesky_candidates(id) on delete cascade,
  target_profile_id uuid not null
    references public.bluesky_target_profiles(id) on delete cascade,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  times_seen integer not null default 1,

  created_at timestamptz not null default now(),

  unique (candidate_id, target_profile_id)
);

comment on table public.bluesky_candidate_sources is
  'Which target profiles each candidate was discovered from. Additive: '
  'a candidate found again under a second target gains a row and keeps '
  'the first.';

create index if not exists bluesky_candidate_sources_target_idx
  on public.bluesky_candidate_sources (target_profile_id);

create index if not exists bluesky_candidate_sources_candidate_idx
  on public.bluesky_candidate_sources (candidate_id);

-- =====================================================================
-- 5. Action batches — immutable membership
-- =====================================================================
--
-- A batch's membership is fixed at confirmation. It is not a filter
-- that gets re-evaluated, and not a saved query: the operator's chosen
-- candidates are written as bluesky_relationship_actions rows in the
-- same transaction that creates the batch, and `requested_count` is
-- frozen at that moment.
--
-- A trigger below then refuses any INSERT of an action into a batch
-- that already has a confirmed_at. That is what makes "newly imported
-- candidates can never join a confirmed batch" a property of the
-- database rather than a promise made by the code.

create table if not exists public.bluesky_action_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  operator_account_id uuid not null
    references public.growth_accounts(id) on delete cascade,

  action_type text not null check (action_type in ('follow', 'unfollow')),

  status text not null default 'pending' check (status in (
    'pending',      -- rows written, not yet confirmed (transient)
    'confirmed',    -- operator confirmed; membership now frozen
    'running',
    'paused',       -- stopped safely (rate limit / auth / operator)
    'completed',    -- every action reached a terminal state
    'failed'
  )),

  -- Frozen at confirmation. Compared against the actual row count by a
  -- guard test; a mismatch means membership changed after confirmation.
  requested_count integer not null default 0,
  processed_count integer not null default 0,
  succeeded_count integer not null default 0,
  failed_count integer not null default 0,
  reconciliation_required_count integer not null default 0,

  stop_reason text,
  last_error text,

  confirmed_at timestamptz,
  confirmed_by uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.bluesky_action_batches is
  'An operator-confirmed set of relationship mutations. Membership is '
  'frozen at confirmed_at and enforced immutable by a trigger — Signal '
  'never widens a batch the operator already approved.';

create index if not exists bluesky_action_batches_ws_idx
  on public.bluesky_action_batches (workspace_id, operator_account_id, created_at desc);

drop trigger if exists bluesky_action_batches_touch on public.bluesky_action_batches;
create trigger bluesky_action_batches_touch
  before update on public.bluesky_action_batches
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 6. Relationship actions — the mutation and its permanent audit record
-- =====================================================================
--
-- Append-only in spirit: a row is created pending and then advances
-- through states, but it is NEVER deleted and never rewritten to erase
-- what happened. Unfollowing does not remove the follow action that
-- preceded it; both rows stand.
--
-- `reconciliation_required` is a real terminal-ish state, not a
-- disguised failure. It means: we do not know whether the provider
-- applied the mutation, we have read the provider's relationship truth,
-- and the next mutation is an operator decision rather than an
-- automatic retry. createRecord is not idempotent, so a blind retry of
-- an ambiguous follow risks a duplicate follow record that nothing
-- tracks.

create table if not exists public.bluesky_relationship_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  operator_account_id uuid not null
    references public.growth_accounts(id) on delete cascade,

  -- Nullable so an action survives a candidate row being removed; the
  -- DID below is the durable record either way.
  candidate_id uuid references public.bluesky_candidates(id) on delete set null,
  batch_id uuid references public.bluesky_action_batches(id) on delete set null,

  action_type text not null check (action_type in ('follow', 'unfollow')),

  -- Audit identity: the DID is authoritative, the handle is what it
  -- looked like AT THE TIME. Keeping the historical handle is the point
  -- — a later rename must not rewrite what the operator saw.
  subject_did text not null check (subject_did like 'did:%'),
  subject_handle_at_action text,

  -- The operator's own Bluesky account, as DID. Recorded per action so
  -- history stays readable if the connection row is later replaced.
  actor_did text,
  actor_handle_at_action text,

  status text not null default 'pending' check (status in (
    'pending',
    'running',
    'succeeded',
    'failed',
    'skipped',                  -- excluded before any provider call
                                -- (protected, already in target state)
    'reconciliation_required'   -- provider outcome unknown; truth read;
                                -- next mutation is the operator's call
  )),

  -- Provider follow-record identity produced or consumed by THIS action.
  follow_uri text,
  follow_rkey text,
  follow_cid text,

  -- Verbatim-ish provider outcome. No secrets: the JWT never enters
  -- this column, and the app password never exists at this layer.
  provider_status_code integer,
  provider_error_code text,
  provider_error_message text,

  -- What a reconciliation read observed, and when. Stored rather than
  -- folded into the status so "we checked and it said X" survives.
  reconciled_state text check (reconciled_state is null or reconciled_state in (
    'unknown', 'not_following', 'following', 'follows_you', 'mutual'
  )),
  reconciled_at timestamptz,
  reconciliation_note text,

  -- Which target profile(s) surfaced this DID at action time. Denormalised
  -- deliberately: bluesky_candidate_sources keeps changing as imports
  -- run, and history must record what was true when the operator acted.
  source_target_profile_ids uuid[] not null default '{}',

  initiated_by uuid references auth.users(id) on delete set null,
  -- 'operator_single' | 'operator_batch'. There is no other value and
  -- no scheduled/automatic initiator: every mutation in this subsystem
  -- is explicitly started by a person.
  initiator_kind text not null default 'operator_single'
    check (initiator_kind in ('operator_single', 'operator_batch')),

  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.bluesky_relationship_actions is
  'Permanent audit record of every follow/unfollow. Never deleted and '
  'never rewritten when relationship state later changes: an unfollow '
  'adds a row, it does not retract the follow that preceded it.';

comment on column public.bluesky_relationship_actions.status is
  'reconciliation_required means the provider outcome was unknown, the '
  'relationship truth has been read, and whether to mutate again is an '
  'operator decision. It is not a retry queue.';

comment on column public.bluesky_relationship_actions.subject_handle_at_action is
  'The handle as it appeared when the operator acted. Never backfilled '
  'from the current handle — that would rewrite history.';

create index if not exists bluesky_relationship_actions_batch_idx
  on public.bluesky_relationship_actions (batch_id, status);

create index if not exists bluesky_relationship_actions_ws_time_idx
  on public.bluesky_relationship_actions (workspace_id, operator_account_id, requested_at desc);

create index if not exists bluesky_relationship_actions_candidate_idx
  on public.bluesky_relationship_actions (candidate_id, requested_at desc);

-- Duplicate-action guard.
--
-- At most ONE action per (operator identity, subject DID, action type)
-- may be in flight at a time. A partial unique index is used rather than
-- an application check because the check-then-insert race is exactly how
-- duplicate follows happen, and createRecord will happily mint a second
-- follow record if it is called twice.
create unique index if not exists bluesky_relationship_actions_one_active
  on public.bluesky_relationship_actions
     (workspace_id, operator_account_id, subject_did, action_type)
  where status in ('pending', 'running');

comment on index public.bluesky_relationship_actions_one_active is
  'One in-flight action per (identity, subject, type). Enforced in the '
  'database because check-then-insert races are precisely how duplicate '
  'follow records get created — createRecord mints a new rkey per call.';

drop trigger if exists bluesky_relationship_actions_touch
  on public.bluesky_relationship_actions;
create trigger bluesky_relationship_actions_touch
  before update on public.bluesky_relationship_actions
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 7. Batch membership immutability — enforced, not promised
-- =====================================================================
--
-- Refuses to add an action to a batch that has been confirmed, and
-- refuses to move an existing action into a different batch. Newly
-- discovered candidates therefore cannot be swept into work the
-- operator already approved, no matter what the application does.

create or replace function public.bluesky_batch_membership_is_frozen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_confirmed_at timestamptz;
begin
  if tg_op = 'INSERT' then
    if new.batch_id is null then
      return new;
    end if;
    select confirmed_at into v_confirmed_at
      from public.bluesky_action_batches
     where id = new.batch_id;
    if v_confirmed_at is not null then
      raise exception
        'bluesky batch % is confirmed; its membership is immutable', new.batch_id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- UPDATE: an action may advance through statuses, but it may never
  -- change which batch it belongs to.
  if new.batch_id is distinct from old.batch_id then
    raise exception
      'bluesky action % cannot be moved between batches', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function public.bluesky_batch_membership_is_frozen() is
  'Blocks adding an action to a confirmed batch and blocks reassigning '
  'an action between batches. This is the database-level guarantee '
  'behind "a confirmed batch is immutable in membership".';

drop trigger if exists bluesky_relationship_actions_batch_frozen
  on public.bluesky_relationship_actions;
create trigger bluesky_relationship_actions_batch_frozen
  before insert or update on public.bluesky_relationship_actions
  for each row execute function public.bluesky_batch_membership_is_frozen();

-- =====================================================================
-- 8. RLS — workspace-scoped, same pattern as every other table
-- =====================================================================
--
-- Membership gates visibility. It does NOT gate which operator may
-- mutate a relationship: that is a `connect_platforms` permission check
-- in the server action, because RLS here has no view of the caller's
-- role beyond membership. Client visibility is never the boundary.
--
-- No DELETE policy on the action or batch tables: history is not
-- deletable through the API.

alter table public.bluesky_target_profiles enable row level security;
alter table public.bluesky_import_runs enable row level security;
alter table public.bluesky_candidates enable row level security;
alter table public.bluesky_candidate_sources enable row level security;
alter table public.bluesky_action_batches enable row level security;
alter table public.bluesky_relationship_actions enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'bluesky_target_profiles',
    'bluesky_import_runs',
    'bluesky_candidates',
    'bluesky_candidate_sources',
    'bluesky_action_batches',
    'bluesky_relationship_actions'
  ] loop
    execute format(
      'drop policy if exists %I on public.%I',
      t || ': members read', t);
    execute format(
      'create policy %I on public.%I for select using (public.is_workspace_member(workspace_id))',
      t || ': members read', t);

    execute format(
      'drop policy if exists %I on public.%I',
      t || ': members insert', t);
    execute format(
      'create policy %I on public.%I for insert with check (public.is_workspace_member(workspace_id))',
      t || ': members insert', t);

    execute format(
      'drop policy if exists %I on public.%I',
      t || ': members update', t);
    execute format(
      'create policy %I on public.%I for update using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id))',
      t || ': members update', t);
  end loop;
end;
$$;

-- Target profiles and candidates may be removed by a member (an
-- operator can drop a target they no longer care about). Actions and
-- batches may not: they are the audit trail.
drop policy if exists "bluesky_target_profiles: members delete"
  on public.bluesky_target_profiles;
create policy "bluesky_target_profiles: members delete"
  on public.bluesky_target_profiles for delete
  using (public.is_workspace_member(workspace_id));
