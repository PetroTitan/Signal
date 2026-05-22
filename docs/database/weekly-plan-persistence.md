# Weekly plan persistence

`/weekly-plan` is now a server component that reads from `weekly_plans` + `weekly_plan_items`.

## Domain shape

| Domain field | Source column | Notes |
| --- | --- | --- |
| `weeklyPlan.id` | `weekly_plans.id` | UUID. |
| `weeklyPlan.title` | `weekly_plans.title` | Defaults to "This week". |
| `weeklyPlan.weekStart` | `weekly_plans.week_start` | ISO date string (no time component). Defaults to the ISO Monday of the current week. |
| `weeklyPlan.status` | `weekly_plans.status` | draft / review / approved / archived. |
| `weeklyPlanItem.status` | `weekly_plan_items.status` | nine values from the existing engine; new items default to `pending_approval`. |
| `weeklyPlanItem.riskLevel` | `weekly_plan_items.risk_level` | low / medium / high / blocked. Risk is recorded separately in `risk_events`. |
| `weeklyPlanItem.scheduledAt` | `weekly_plan_items.scheduled_at` | Nullable; set when the scheduler is run. |
| `weeklyPlanItem.metadata` | `weekly_plan_items.metadata` | JSONB — used today for `restoredFrom` on backlog-restored items. |

## Functions

- `listWeeklyPlans(workspaceId, limit?)` — recent plans, week-start desc.
- `getCurrentWeeklyPlan(workspaceId)` — most recent week-start.
- `getWeeklyPlanById(workspaceId, planId)`.
- `createWeeklyPlan({ workspaceId, title, weekStart })`.
- `updateWeeklyPlanStatus({ workspaceId, planId, status })`.
- `listPlanItems(workspaceId, planId)`.
- `listPlanItemsByStatus(workspaceId, statuses)` — used by the approval queue and the scheduler.
- `getPlanItemById`, `createPlanItem`, `updatePlanItem`, `updatePlanItemStatus`.

## Server actions

- `createWeeklyPlanAction` — creates a plan for the current week (or a provided `week_start`) and writes a `weekly_plan.created` activity event.
- `createPlanItemAction` — creates the current plan if missing, then inserts a new item as `pending_approval` and writes a `weekly_plan_item.created` activity event.

## UI

`/weekly-plan` (server component):

- Renders an honest empty state when no plan exists.
- Renders an honest empty state when a plan exists but has no items.
- Otherwise renders the item list with platform, content type, schedule time, and a status chip.
- Always renders the `CreateItemForm` below, with product and account selectors pulled from the workspace.

## Demo mode

The DB-backed weekly plan does not consume demo fixtures. Demo mode continues to gate the in-store data used by other engine-driven pages (`/scheduler`, `/risk-center`, etc.).

## What is **not** persisted yet

- Draft variants per item (table exists; UI integration is pending).
- Risk events per item (table exists; emitted opportunistically, not as part of the create-item flow).
- Schedule slot per item (table exists; surface migration is pending).

The tables exist so a future phase can wire these in without a schema migration.
