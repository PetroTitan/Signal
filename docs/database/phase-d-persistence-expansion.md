# Phase D — persistence expansion

Phase D takes Signal from a workspace + product + account foundation to a real operational system. Weekly plans, plan items, approvals, backlog, scheduled items, risk events, and draft variants are all persisted with workspace-scoped RLS.

## What Phase D shipped

- 7 new tables, all RLS-protected: `weekly_plans`, `weekly_plan_items`, `approval_events`, `backlog_items`, `scheduled_items`, `risk_events`, `draft_variants`.
- 6 new repositories under `src/repositories/` (`weekly-plan`, `approval`, `backlog`, `scheduled-item`, `risk-event`, `draft-variant`).
- Server actions for: creating a weekly plan, creating a plan item, approving / rejecting / sending-to-backlog an item, restoring or archiving a backlog item.
- UI migrations for `/weekly-plan`, `/approval-queue`, and `/backlog` — all three are now server components reading from Supabase.
- Activity events expanded: each Phase D operation writes an `activity_events` row, so `/activity` reflects the real operational timeline.

## What Phase D did **not** ship

- No OpenAI runtime. The AI provider stays mock.
- No Reddit / X / LinkedIn OAuth, no publishing, no auto-commenting.
- No Stripe, no billing, no background jobs, no edge functions.
- No WebmasterID analytics ingestion.
- No persistence migration for `/scheduler`, `/risk-center`, `/dashboard`, `/platforms/*`, `/content-intelligence`, `/comments`, `/discussions`, `/opportunities`, `/discoverability`. Those continue to render from the in-memory React store; their persistence migration is a later phase.

## Engines stay database-agnostic

The deterministic engines under `src/core/` (scheduler, risk, approval, content intelligence, comment intelligence) are unchanged. They consume typed domain objects, not DB rows. The repository layer is the only thing that knows about Supabase.

## Migrations to apply

Two new SQL files live under `supabase/migrations/`:

- `20260522010001_phase_d_schema.sql` — table definitions, indexes, triggers.
- `20260522010002_phase_d_rls.sql` — RLS enable + per-table policies.

Apply with:

```bash
supabase db push
```

Phase C migrations (`20260522000001_phase_c_schema.sql`, `20260522000002_phase_c_rls.sql`) are pre-requisites and must already be applied — the Phase D RLS migration reuses `public.is_workspace_member()` and `public.is_workspace_owner()` from Phase C.

## See also

- [./phase-d-migrations.md](./phase-d-migrations.md)
- [./weekly-plan-persistence.md](./weekly-plan-persistence.md)
- [./approval-backlog-scheduler-persistence.md](./approval-backlog-scheduler-persistence.md)
- [./risk-draft-persistence.md](./risk-draft-persistence.md)
- [./activity-events-phase-d.md](./activity-events-phase-d.md)
- [./repository-layer.md](./repository-layer.md)
