# Simple Weekly Publishing Workflow (Phase F1)

Signal's publishing model has exactly one shape:

1. **Plan** — Items land on `/weekly-plan` as `pending_approval`.
2. **Approve** — Operator clicks **Approve weekly plan**. Eligible items
   become `execution_items` with `status='scheduled'`.
3. **Tick** — `/api/scheduler/tick` runs on a cron (every 5 minutes by
   default). It loads each scheduled item, runs the policy gate, and
   either publishes (dry-run by default) or marks it `skipped` /
   `blocked` / `failed` with a reason code.
4. **Result** — `weekly_plan_items.status` is mirrored to
   `published` (success), `paused` (failed/blocked), or stays
   `scheduled` (skipped — retried on next tick).

There is **no** continuous AI loop, browser automation, account
creation, or autonomous content generation. The operator stays in
control of *what* and *when*; the scheduler handles only the
mechanical delivery of approved items.

## State machine

`weekly_plan_items.status`

```
draft  →  pending_approval  →  scheduled  →  published
                              ↘            ↘
                                paused      paused (failed)
```

`execution_items.status` (unchanged from Phase E2)

```
pending_authorization → authorized → scheduled → running → completed
                                               ↘ blocked / failed / skipped
```

`approveWeeklyPlanAction` walks new items through
`pending_authorization → authorized → scheduled` in a single call so
the scheduler picks them up on the next tick.

## What the approve action does

[`approveWeeklyPlanAction`](../../src/app/(app)/weekly-plan/_actions.ts):

1. Loads the active weekly contract. **Required** — fails fast if
   none.
2. Lists `pending_approval` items on the plan.
3. Filters items by contract scope (`accountIds`, `productIds`,
   `platforms`, `maxRiskLevel`). Out-of-scope items are reported as
   warnings, not failures.
4. Reuses (or creates) the execution queue for that contract.
5. For each in-scope item: creates an `execution_item`, walks it to
   `scheduled`, bumps the plan item to `scheduled`, writes an
   `execution_log` row, and records a workspace activity event.

The action is idempotent in the sense that re-approving a plan that
has no `pending_approval` items returns `actionFail("Nothing to
approve.")` instead of double-scheduling.

## Surfaces that show this

- **`/weekly-plan`** — Approve button + status counts.
- **`/approval-queue`** — Items disappear once approved.
- **`/execution`** — "Upcoming scheduled" and "Recent results"
  sections list what the scheduler is doing.
- **`/activity`** — `weekly_plan.approved` event.

## What this workflow does *not* do

- ❌ Generate content automatically. Title and body must be authored
  before approval (via UI or MCP).
- ❌ Run continuously. Each tick is a single batch.
- ❌ Comment, vote, moderate, or DM. Reddit text + link posts only.
- ❌ Connect OAuth. The operator does that explicitly at
  `/accounts` once the cipher layer is wired.
- ❌ Touch X, LinkedIn, or Google in F1. Those publishers return
  `not_implemented`.

## Related

- [`docs/publishing/reddit-publishing.md`](./reddit-publishing.md) —
  Reddit API specifics.
- [`docs/publishing/publishing-safety.md`](./publishing-safety.md) —
  Every gate before a real POST.
- [`docs/publishing/oauth-requirements.md`](./oauth-requirements.md) —
  What `connected` means in practice.
