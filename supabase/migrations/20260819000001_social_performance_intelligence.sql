-- Social Trust & Performance Intelligence — schema extensions.
--
-- Strictly ADDITIVE. No column is dropped, no row is rewritten, no
-- default changes. The three parts:
--
--   1. Widen publish_history.mode so a publication can be attributed to
--      something other than "Signal's API" or "a human using Signal".
--   2. Extend post_metrics with the provenance a measurement needs to be
--      interpretable: the PROVIDER's timestamp, the post's age at read
--      time, freshness, confidence, and the payload shape it came from.
--   3. Add account_snapshots — follower/following/post counts over time.
--      Account-level context has nowhere to live in post_metrics because
--      it is not per-post.
--
-- Deliberately NOT done here: no new post-snapshot table. post_metrics
-- already stores history as extra immutable rows keyed
-- `snapshot:<source>:<hour>` against its unique (publish_history_id,
-- source) constraint. A parallel table would split the read path and
-- duplicate the no-clobber persist logic.

set search_path = public;

-- =====================================================================
-- 1. publish_history.mode — publication method
-- =====================================================================
--
-- Existing values stay exactly as they are. All 92 production rows are
-- 'api' and none is touched; 'api' remains the column default because
-- every call site that omits the value is a genuine Signal-API path.
--
--   api       published by Signal through a provider API
--   manual    a human published it and recorded it in Signal
--             (covers both the Reddit paste flow and manual distribution)
--   external  discovered on the provider but never seen by Signal —
--             a native post the operator made outside the product
--   unknown   attribution genuinely undetermined; never a guess
--
-- The constraint is named `publish_history_mode_check` (auto-generated
-- from the inline column check in 20260523000004, verified against the
-- live catalogue before this migration was written). `if exists` would
-- silently no-op on a name mismatch and leave the OLD narrow constraint
-- in force, so the drop is unconditional and will fail loudly instead.

alter table public.publish_history
  drop constraint publish_history_mode_check;

alter table public.publish_history
  add constraint publish_history_mode_check
  check (mode in ('api', 'manual', 'external', 'unknown'));

comment on column public.publish_history.mode is
  'How the post reached the platform: api (Signal published it), manual '
  '(a human published it and recorded it here), external (found on the '
  'provider, never published through Signal), unknown (undetermined). '
  'Never inferred — a writer that cannot establish the method uses unknown.';

-- =====================================================================
-- 2. post_metrics — measurement provenance
-- =====================================================================
--
-- All nullable with no default: a row written before this migration is
-- honestly "we do not know", which is the whole point. Backfilling a
-- value here would be inventing provenance.

alter table public.post_metrics
  -- The PROVIDER's own timestamp (Bluesky indexedAt, X created_at). Not
  -- the same instant as publish_history.finished_at, which records when
  -- Signal's request completed. Age normalization must key off this.
  add column if not exists provider_published_at timestamptz,

  -- Hours between provider_published_at and fetched_at. Stored rather
  -- than derived so a snapshot stays interpretable even if the provider
  -- later revises its timestamp.
  add column if not exists age_hours numeric,

  -- Which normalized comparison window this reading falls in.
  add column if not exists age_window text
    check (age_window is null or age_window in ('1h','6h','24h','72h','7d','older')),

  -- Whether the value can be presented as current. 'stale' is a real,
  -- displayable state; presenting stale numbers as live is the failure
  -- this column exists to prevent.
  add column if not exists freshness text
    check (freshness is null or freshness in
      ('fresh','stale','unavailable','rate_limited','provider_error')),

  -- How much of the metric set the provider actually returned.
  --   verified  every metric the platform supports was present
  --   partial   the provider answered but omitted some supported metrics
  --   unknown   provenance not recorded (pre-migration rows)
  add column if not exists confidence text
    check (confidence is null or confidence in ('verified','partial','unknown')),

  -- The response shape the counts were parsed from, e.g.
  -- 'x_api_v2:public_metrics:1'. Lets a future parser change invalidate
  -- rows it can no longer vouch for instead of silently reinterpreting.
  add column if not exists provider_payload_version text;

comment on column public.post_metrics.provider_published_at is
  'Provider-reported publication instant. NOT publish_history.finished_at.';
comment on column public.post_metrics.age_window is
  'Normalized post-age bucket at fetch time. Comparing posts of different '
  'ages without this is invalid.';
comment on column public.post_metrics.freshness is
  'Presentation state of the cached value. Stale data is shown as stale.';

-- Age-window queries scan by platform + window; 92 publications today,
-- but the index keeps the comparison path honest as history grows.
create index if not exists post_metrics_age_window_idx
  on public.post_metrics (workspace_id, platform, age_window)
  where age_window is not null;

-- =====================================================================
-- 3. account_snapshots — audience context over time
-- =====================================================================
--
-- Follower count is not decoration: the primary Bluesky identity has one
-- follower, and without that number every engagement figure on it is
-- uninterpretable. This is account-scoped, so it cannot live in
-- post_metrics.
--
-- Idempotency reuses the post_metrics convention rather than inventing a
-- second one: `source` carries an hour bucket for history rows
-- ('snapshot:<provider_source>:<YYYY-MM-DDTHH>'), and the unique
-- constraint makes a re-run within the hour a no-op.

create table if not exists public.account_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  account_id uuid not null references public.growth_accounts(id) on delete cascade,
  platform text not null,

  -- Provider identity as observed, so a handle change is visible.
  provider_account_id text,
  handle text,

  -- NULL means "the provider did not tell us", never zero.
  followers integer,
  following integer,
  post_count integer,
  provider_created_at timestamptz,

  source text not null,
  freshness text not null default 'fresh'
    check (freshness in ('fresh','stale','unavailable','rate_limited','provider_error')),
  error text,

  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  unique (account_id, source)
);

comment on table public.account_snapshots is
  'Provider-reported account context (followers/following/post count) over '
  'time. NULL counts mean the provider did not report a value; they are '
  'never coerced to zero.';

create index if not exists account_snapshots_ws_fetched_idx
  on public.account_snapshots (workspace_id, fetched_at desc);

create index if not exists account_snapshots_account_fetched_idx
  on public.account_snapshots (account_id, fetched_at desc);

-- RLS — same workspace-member pattern as post_metrics.

alter table public.account_snapshots enable row level security;

drop policy if exists "account_snapshots: members read" on public.account_snapshots;
create policy "account_snapshots: members read"
  on public.account_snapshots for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "account_snapshots: members insert" on public.account_snapshots;
create policy "account_snapshots: members insert"
  on public.account_snapshots for insert
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "account_snapshots: members update" on public.account_snapshots;
create policy "account_snapshots: members update"
  on public.account_snapshots for update
  using (public.is_workspace_member(workspace_id));
