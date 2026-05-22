-- Phase E1 — Weekly Operating Contract.
--
-- The user approves once per week. Signal may then operate for 7 days
-- within explicitly approved boundaries. This migration adds the
-- contract envelope, its scoping rows (accounts / products / platforms /
-- allowed actions / execution windows), and the per-action
-- execution_authorizations audit trail.
--
-- Nothing here implements autopublishing, OAuth posting, browser
-- automation, platform login automation, or autonomous commenting. The
-- tables only describe the *boundary* the runner respects when it later
-- asks "can this action run?".
--
-- Rules:
--   * All tables are workspace-scoped and reference
--     public.workspaces(id) on delete cascade.
--   * RLS lives in 20260522040002_phase_e1_weekly_contract_rls.sql.
--   * No service-role-key path. All writes go through the standard
--     authenticated user + is_workspace_member checks.

set search_path = public;

-- WEEKLY APPROVAL CONTRACTS ---------------------------------------------------
--
-- One row per approval envelope. `status` is the lifecycle: a draft
-- becomes pending_approval → approved → active → (expired | paused |
-- revoked). Only `active` contracts authorize execution.

create table if not exists public.weekly_approval_contracts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,

  title text not null,
  week_start date not null,
  week_end date not null,

  status text not null default 'draft' check (status in (
    'draft',
    'pending_approval',
    'approved',
    'active',
    'paused',
    'expired',
    'revoked'
  )),

  -- Risk envelope (mirrored in src/core/weekly-contract/contract-risk.ts).
  max_risk_level text not null default 'medium' check (max_risk_level in (
    'low', 'medium', 'high'
  )),

  -- Cadence ceilings the runner must respect. NULL = unlimited.
  max_actions_total integer check (max_actions_total is null or max_actions_total >= 0),
  max_actions_per_day integer check (max_actions_per_day is null or max_actions_per_day >= 0),
  max_actions_per_platform_per_day integer check (
    max_actions_per_platform_per_day is null or max_actions_per_platform_per_day >= 0
  ),

  -- Pause triggers
  pause_on_first_failure boolean not null default true,
  pause_on_risk_event boolean not null default true,

  -- Free-form notes the user wrote when granting approval.
  notes text,

  approval_text_phrase text,
  approved_at timestamptz,
  activated_at timestamptz,
  paused_at timestamptz,
  expired_at timestamptz,
  revoked_at timestamptz,

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint weekly_contract_week_range_check
    check (week_end >= week_start)
);

create index if not exists weekly_contracts_workspace_status_idx
  on public.weekly_approval_contracts (workspace_id, status);

create index if not exists weekly_contracts_workspace_week_idx
  on public.weekly_approval_contracts (workspace_id, week_start desc);

-- Only one active contract per workspace at a time. Drafts and
-- expired/revoked rows can coexist.
create unique index if not exists weekly_contracts_one_active_per_workspace
  on public.weekly_approval_contracts (workspace_id)
  where status = 'active';

drop trigger if exists weekly_approval_contracts_touch on public.weekly_approval_contracts;
create trigger weekly_approval_contracts_touch
  before update on public.weekly_approval_contracts
  for each row execute function public.touch_updated_at();

-- CONTRACT SCOPE: ACCOUNTS ----------------------------------------------------
--
-- Which growth_accounts the contract covers. Empty set = no accounts
-- (the contract authorizes nothing). The runner refuses to execute
-- against an account that is not present here.

create table if not exists public.weekly_contract_accounts (
  contract_id uuid not null references public.weekly_approval_contracts(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  account_id uuid not null references public.growth_accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (contract_id, account_id)
);

create index if not exists weekly_contract_accounts_workspace_idx
  on public.weekly_contract_accounts (workspace_id);

-- CONTRACT SCOPE: PRODUCTS ----------------------------------------------------

create table if not exists public.weekly_contract_products (
  contract_id uuid not null references public.weekly_approval_contracts(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (contract_id, product_id)
);

create index if not exists weekly_contract_products_workspace_idx
  on public.weekly_contract_products (workspace_id);

-- CONTRACT SCOPE: PLATFORMS ---------------------------------------------------
--
-- Platform names are stored as text and validated against
-- src/core/platforms/* in TypeScript. We keep them open here so the
-- contract layer doesn't bottleneck future platform additions.

create table if not exists public.weekly_contract_platforms (
  contract_id uuid not null references public.weekly_approval_contracts(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  platform text not null,
  created_at timestamptz not null default now(),
  primary key (contract_id, platform)
);

create index if not exists weekly_contract_platforms_workspace_idx
  on public.weekly_contract_platforms (workspace_id);

-- CONTRACT SCOPE: ALLOWED ACTIONS --------------------------------------------
--
-- Which action types the contract permits. Phase E1 ships a fixed set;
-- nothing here authorizes login automation or freeform AI execution.
-- New action types are added by migration, not by user input.

create table if not exists public.weekly_contract_allowed_actions (
  contract_id uuid not null references public.weekly_approval_contracts(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  action_type text not null check (action_type in (
    'publish_scheduled_post',
    'publish_scheduled_comment',
    'send_engagement_signal',
    'mark_item_skipped',
    'rotate_to_backlog',
    'open_pr_for_review',
    'request_screenshot_import',
    'request_profile_suggestion'
  )),
  created_at timestamptz not null default now(),
  primary key (contract_id, action_type)
);

create index if not exists weekly_contract_allowed_actions_workspace_idx
  on public.weekly_contract_allowed_actions (workspace_id);

-- CONTRACT SCOPE: EXECUTION WINDOWS ------------------------------------------
--
-- Day-of-week + time-of-day windows during which execution is
-- authorized. Anything outside the window is denied (soft_block). Stored
-- in workspace local time per workspace_settings.timezone — the runner
-- resolves to a concrete tz at evaluation time.

create table if not exists public.weekly_contract_execution_windows (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.weekly_approval_contracts(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- 0 = Sunday … 6 = Saturday. Matches JS Date.getDay().
  day_of_week smallint not null check (day_of_week between 0 and 6),

  -- "HH:MM" 24h strings. Inclusive start, exclusive end.
  start_time text not null check (start_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  end_time text not null check (end_time ~ '^[0-2][0-9]:[0-5][0-9]$'),

  created_at timestamptz not null default now()
);

create index if not exists weekly_contract_execution_windows_contract_idx
  on public.weekly_contract_execution_windows (contract_id);

create index if not exists weekly_contract_execution_windows_workspace_idx
  on public.weekly_contract_execution_windows (workspace_id);

-- EXECUTION AUTHORIZATIONS ----------------------------------------------------
--
-- Append-only ledger. Every time the runner evaluates "can this action
-- run?" it writes one row. The decision lives in `outcome` and the
-- reason in `reason_code`. This is the audit trail behind the weekly
-- contract.

create table if not exists public.execution_authorizations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contract_id uuid references public.weekly_approval_contracts(id) on delete set null,

  -- The thing being evaluated.
  action_type text not null,
  account_id uuid references public.growth_accounts(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  platform text,

  -- Scheduled item / plan item the action belongs to, when known.
  scheduled_item_id uuid references public.scheduled_items(id) on delete set null,
  weekly_plan_item_id uuid references public.weekly_plan_items(id) on delete set null,

  -- Result.
  outcome text not null check (outcome in (
    'allowed', 'soft_block', 'hard_block'
  )),
  reason_code text not null check (reason_code in (
    'allowed',
    'no_active_contract',
    'contract_paused',
    'contract_expired',
    'account_out_of_scope',
    'product_out_of_scope',
    'platform_out_of_scope',
    'action_not_permitted',
    'risk_above_ceiling',
    'cadence_total_exceeded',
    'cadence_per_day_exceeded',
    'cadence_per_platform_exceeded',
    'outside_execution_window',
    'paused_by_failure',
    'paused_by_risk_event',
    'demo_mode_blocked'
  )),
  reason_detail text,

  -- Suggested follow-up for the UI. Lets the runner say "we sent this
  -- to the backlog" or "we paused the contract" without the caller
  -- having to know the policy table.
  suggested_action text check (suggested_action in (
    'proceed',
    'send_to_backlog',
    'reschedule',
    'pause_contract',
    'request_new_approval'
  )),
  should_backlog boolean not null default false,
  should_pause boolean not null default false,

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists execution_auth_workspace_created_idx
  on public.execution_authorizations (workspace_id, created_at desc);

create index if not exists execution_auth_contract_created_idx
  on public.execution_authorizations (contract_id, created_at desc)
  where contract_id is not null;

create index if not exists execution_auth_workspace_outcome_idx
  on public.execution_authorizations (workspace_id, outcome);
