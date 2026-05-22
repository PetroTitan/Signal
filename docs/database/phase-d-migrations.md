# Phase D migrations

Two migrations under `supabase/migrations/` add the Phase D schema and RLS policies. Both are idempotent and safe to re-run.

## Files

- `20260522010001_phase_d_schema.sql`
- `20260522010002_phase_d_rls.sql`

## Tables

| Table | Purpose |
| --- | --- |
| `weekly_plans` | One row per workspace-week. Unique `(workspace_id, week_start)`. Status: draft / review / approved / archived. |
| `weekly_plan_items` | Items inside a plan. References `weekly_plans` (cascade) and optionally `products` / `growth_accounts`. Status check covers nine values. `risk_level` is a CHECK constraint. `metadata` is JSONB. |
| `approval_events` | Append-only audit log. References `weekly_plan_items`. Action check covers eleven values. |
| `backlog_items` | Items held for future weeks. `source_item_id` references `weekly_plan_items`. Status: backlog / restored / archived. |
| `scheduled_items` | Concrete scheduled slots. References `weekly_plan_items`. Status: scheduled / paused / published / cancelled. |
| `risk_events` | Append-only risk signals. `entity_type` + `entity_id` is the polymorphic target. Risk level is checked. |
| `draft_variants` | AI / hand drafts associated with a plan item. References `weekly_plan_items`. Status: draft / selected / discarded. |

## Indexes

- `weekly_plans(workspace_id, week_start DESC)` for the "list recent weeks" query.
- `weekly_plans(workspace_id, week_start)` UNIQUE — one plan per workspace-week.
- `weekly_plan_items(weekly_plan_id)`.
- `weekly_plan_items(workspace_id, status)` for the approval queue read.
- `weekly_plan_items(workspace_id, scheduled_at)` for the scheduler read.
- `approval_events(workspace_id, created_at DESC)`.
- `approval_events(weekly_plan_item_id)`.
- `backlog_items(workspace_id, status)`.
- `scheduled_items(workspace_id, scheduled_at)`.
- `scheduled_items(weekly_plan_item_id)`.
- `risk_events(workspace_id, created_at DESC)`.
- `risk_events(entity_type, entity_id)`.
- `draft_variants(weekly_plan_item_id)`.
- `draft_variants(workspace_id)`.

## Triggers

`touch_updated_at()` from Phase C is reused. New triggers cover `weekly_plans`, `weekly_plan_items`, `backlog_items`, `scheduled_items`, and `draft_variants`. Append-only tables (`approval_events`, `risk_events`) don't need them.

## RLS policy summary

| Table | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| `weekly_plans` | members | members (`created_by = auth.uid()` or null) | members | owners |
| `weekly_plan_items` | members | members | members | members |
| `approval_events` | members | members (actor must be self if set) | — | — |
| `backlog_items` | members | members | members | members |
| `scheduled_items` | members | members | members | members |
| `risk_events` | members | members | — | — |
| `draft_variants` | members | members | members | members |

Append-only tables (`approval_events`, `risk_events`) have no update / delete policies by design — past events are not editable from the application.

## Forward compatibility

All Phase D tables carry an opaque `metadata` JSONB column for forward-friendly extension without schema migration. When a future phase needs a typed field that today lives in `metadata`, the pattern is:

1. Add the column as nullable.
2. Backfill from `metadata`.
3. Tighten constraints last.
4. Leave `metadata` in place for legacy data.

## Apply

```bash
supabase db push
```

This applies Phase C **and** Phase D migrations in order (Phase C must precede Phase D — the RLS migration reuses the `is_workspace_member` / `is_workspace_owner` helpers).
