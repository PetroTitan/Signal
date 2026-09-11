-- Phase E0 — MCP operations layer audit columns.
--
-- Adds `source` and `review_status` to products and growth_accounts,
-- and `source` to activity_events. These columns let the
-- MCP-operations layer distinguish hand-entered records from AI- or
-- screenshot-assisted ones, and gate downstream use of an AI-assisted
-- record on user confirmation.
--
-- Rules:
--   * All columns are nullable and default to the safe values
--     ('manual' / 'confirmed'). Existing rows keep their meaning.
--   * No RLS changes. Workspace-scoped isolation continues to apply.
--   * No service-role key required to insert these values.
--
-- The valid value sets are also enforced in TypeScript:
--   src/core/mcp-operations/audit-source.ts
--   src/core/mcp-operations/review-status.ts

set search_path = public;

-- PRODUCTS --------------------------------------------------------------------

alter table public.products
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'ai_assisted', 'screenshot_import', 'mcp_operation', 'system'));

alter table public.products
  add column if not exists review_status text not null default 'confirmed'
    check (review_status in ('pending_review', 'confirmed', 'rejected', 'needs_edit'));

create index if not exists products_workspace_review_idx
  on public.products (workspace_id, review_status);

-- GROWTH ACCOUNTS -------------------------------------------------------------

alter table public.growth_accounts
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'ai_assisted', 'screenshot_import', 'mcp_operation', 'system'));

alter table public.growth_accounts
  add column if not exists review_status text not null default 'confirmed'
    check (review_status in ('pending_review', 'confirmed', 'rejected', 'needs_edit'));

create index if not exists growth_accounts_workspace_review_idx
  on public.growth_accounts (workspace_id, review_status);

-- ACTIVITY EVENTS -------------------------------------------------------------

alter table public.activity_events
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'ai_assisted', 'screenshot_import', 'mcp_operation', 'system'));
