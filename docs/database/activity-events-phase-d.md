# Activity events — Phase D additions

Phase C introduced `activity_events` for workspace / product / account / settings lifecycle events. Phase D extends the event-type catalogue to cover operational workflows.

## Event types

| event_type | Emitted when | entity_type | description |
| --- | --- | --- | --- |
| `workspace.created` | Default workspace bootstrap | `workspace` | (Phase C) |
| `product.created` | New product saved | `product` | (Phase C) |
| `account.created` | New growth account saved | `account` | (Phase C) |
| `settings.updated` | Region / locale changed | `workspace_settings` | (Phase C) |
| `weekly_plan.created` | First plan item triggers plan creation, or explicit create | `weekly_plan` | New |
| `weekly_plan_item.created` | Item added via `createPlanItemAction` | `weekly_plan_item` | New |
| `weekly_plan_item.approved` | Item approved in the approval queue | `weekly_plan_item` | New |
| `weekly_plan_item.rejected` | Item rejected | `weekly_plan_item` | New |
| `backlog_item.created` | Item moved to backlog | `backlog_item` | New |
| `backlog_item.restored` | Backlog item brought back into the current week | `backlog_item` | New |
| `backlog_item.archived` | Backlog item archived | `backlog_item` | New |

The format is deliberately conservative: `<entity>.<verb>`. Future phases will add `scheduled_item.created`, `scheduled_item.paused`, `risk_event.created`, `draft_variant.created` once their UI flows ship.

## How they're written

Every server action ends with a `recordActivity(...)` call. The repository inserts the row with `actor_user_id = auth.uid()` (or null for system events). The RLS policy enforces both workspace membership and the actor self-check.

## How they're read

`/activity` (server component) reads `activity_events` for the current workspace, ordered by `created_at` descending, limited to 80. Real workspace events only — there is no demo path.

Each row renders:

- `event_type` as a small fixed-width label.
- `title` as the primary line.
- `description` (when present) as a one-line context.
- `created_at` as a localized timestamp.

## Append-only

`activity_events` has no UPDATE or DELETE policy. Past events are immutable from the application — important for the trust posture and for future audit needs.

## Forward compatibility

`metadata` (JSONB) is available on every row. Future event types can carry structured context (e.g. `{ "platform": "reddit", "risk_level": "medium" }`) without a schema migration.

## See also

- [./phase-d-migrations.md](./phase-d-migrations.md)
- [./approval-backlog-scheduler-persistence.md](./approval-backlog-scheduler-persistence.md)
- [./repository-layer.md](./repository-layer.md)
