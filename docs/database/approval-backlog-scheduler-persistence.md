# Approval, backlog, and scheduler persistence

## Approval queue

`/approval-queue` (server component) reads `weekly_plan_items` where `status = 'pending_approval'` and exposes three actions per row:

- **Approve** — `approveItemAction` sets the item to `approved`, writes an `approval_events` row with action `approve`, and records a `weekly_plan_item.approved` activity event.
- **Reject** — `rejectItemAction` sets the item to `rejected`, writes an `approval_events` row with action `reject` (optionally with a note), and records a `weekly_plan_item.rejected` activity event.
- **Move to backlog** — `moveToBacklogAction` sets the source item to `backlog`, creates a new `backlog_items` row referencing the source via `source_item_id`, writes an `approval_events` row with action `send_to_backlog`, and records a `backlog_item.created` activity event.

Approval events are append-only by RLS. The actor must be the current user; the policy enforces `actor_user_id = auth.uid()` when set.

## Backlog

`/backlog` (server component) reads `backlog_items` where `status = 'backlog'`. Two actions per row:

- **Restore to this week** — `restoreBacklogItemAction` finds (or creates) the current weekly plan, inserts a new `weekly_plan_items` row with the backlog body / title / platform / product / account, sets the backlog row to `restored`, writes an `approval_events` row with action `restore_from_backlog`, and records a `backlog_item.restored` activity event.
- **Archive** — `archiveBacklogItemAction` sets the backlog row to `archived` and records a `backlog_item.archived` activity event.

Archived backlog rows are kept for the activity timeline. The default listing only shows `backlog`-status rows.

## Scheduler

The scheduler UI continues to render from the in-memory React store. The DB tables for `scheduled_items` exist and the `scheduleItem` / `updateScheduledItem` / `getScheduledItemById` repository methods are in place, but the page-level migration is deferred to a future phase.

When the scheduler page migrates, the pattern follows the approval queue: a server component lists `scheduled_items` for the workspace; server actions write to the table; activity events fire on schedule / pause / unschedule.

## Activity events emitted

Each approval / backlog operation emits exactly one `activity_events` row. The current event-type catalogue from Phase D actions:

| Action | activity_events.event_type |
| --- | --- |
| Approve item | `weekly_plan_item.approved` |
| Reject item | `weekly_plan_item.rejected` |
| Move to backlog | `backlog_item.created` |
| Restore from backlog | `backlog_item.restored` |
| Archive backlog item | `backlog_item.archived` |
| Create plan item | `weekly_plan_item.created` |
| Create weekly plan | `weekly_plan.created` |

`/activity` reads `activity_events` chronologically (most recent first) and renders the operational timeline.

## RLS

All three tables are workspace-scoped. Only members can read or write. Approval events are append-only.

## See also

- [./weekly-plan-persistence.md](./weekly-plan-persistence.md)
- [./activity-events-phase-d.md](./activity-events-phase-d.md)
- [./phase-d-migrations.md](./phase-d-migrations.md)
