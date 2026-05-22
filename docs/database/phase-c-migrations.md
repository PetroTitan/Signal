# Phase C migrations

Two migrations under `supabase/migrations/` apply the Phase C schema and the RLS policies. Apply them with `supabase db push` or whichever CLI flow your project uses.

## Schema migration

File: `20260522000001_phase_c_schema.sql`

Tables:

| Table | Purpose |
| --- | --- |
| `workspaces` | One row per workspace. Owns every other row by `workspace_id`. |
| `workspace_members` | Composite key `(workspace_id, user_id)`. Role check covers owner / admin / editor / reviewer / viewer. |
| `products` | Workspace-scoped product profiles. Name + optional domain, summary, category. |
| `growth_accounts` | Workspace-scoped platform accounts. `connection_status` defaults to `not_connected`. |
| `workspace_settings` | One row per workspace. Region, timezone, language, demo_mode. |
| `activity_events` | Append-only workspace event log. JSONB `metadata` for forward compatibility. |

Indexes:

- `workspace_members(user_id)` for "list my workspaces".
- `products(workspace_id)`, `growth_accounts(workspace_id)`, `growth_accounts(product_id)` for scoped lookups.
- `activity_events(workspace_id, created_at DESC)` for the activity feed.

Triggers:

- `touch_updated_at()` keeps `updated_at` honest on workspaces, products, growth_accounts, and workspace_settings.

## RLS migration

File: `20260522000002_phase_c_rls.sql`

RLS is enabled on every table. Two helper functions in the public schema:

- `public.is_workspace_member(workspace_id)` — `SECURITY DEFINER`, returns true if `auth.uid()` is a member of the given workspace.
- `public.is_workspace_owner(workspace_id)` — same shape, restricted to the `owner` role.

Policy summary:

| Table | Read | Insert | Update | Delete |
| --- | --- | --- | --- | --- |
| `workspaces` | members | anyone (with `created_by = auth.uid()`) | owners | owners |
| `workspace_members` | own row or fellow members | self-insert or owner-insert | owners | owners |
| `products` | members | members | members | members |
| `growth_accounts` | members | members | members | members |
| `workspace_settings` | members | members | members | — |
| `activity_events` | members | members (with `actor_user_id = auth.uid()` if set) | — | — |

No policies allow public reads. No policies depend on the service role.

## Forward compatibility

`schema_version` is not on these tables — Phase C is the first persisted schema, so adding `schema_version` is reserved for future migrations that need to evolve a single row. The pattern for Phase D and beyond is:

1. Add new columns as nullable.
2. Backfill in a separate migration.
3. Tighten constraints last.

Approved drafts and approval events from any future phase must be preserved across schema changes.

## What this migration does **not** create

- No `weekly_plans` / `weekly_plan_items`. These ship with the engine integration in a later phase.
- No `oauth_tokens` table. Wiring OAuth is a future phase; the encrypted-storage plan lives in [oauth-token-storage-plan.md](./oauth-token-storage-plan.md).
- No `memory_*` tables. The memory schema plan lives in [memory-schema-plan.md](./memory-schema-plan.md).

## See also

- [./supabase-auth-foundation.md](./supabase-auth-foundation.md)
- [../security/rls-phase-c.md](../security/rls-phase-c.md)
- [./oauth-token-storage-plan.md](./oauth-token-storage-plan.md)
