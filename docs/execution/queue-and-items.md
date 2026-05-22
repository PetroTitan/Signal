# Queues and items

An `execution_queue` is an envelope; an `execution_item` is a unit. The engine works on items one at a time and reports the rollup at the queue level.

## Creating a queue

`createExecutionQueueAction` requires:

- a workspace
- an `active` weekly contract (the queue carries `contract_id` and inherits `week_start` / `week_end` from it)

The queue lands as `draft` with no items. The partial unique index `execution_queues_one_live_per_contract` blocks creating a second non-terminal queue for the same contract — keeping the UI calm and the runner deterministic.

## Filling a queue

`queueWeeklyPlanItemsAction` pulls every `weekly_plan_items` row with status `approved` or `scheduled`, filters them against the contract scope (account, product, platform), and inserts a matching `execution_items` row for each. The `source_entity_type` / `source_entity_id` columns point back to the plan row.

The action refuses to enqueue if:

- the queue's contract isn't `active`
- the queue is past `draft` / `ready`

Items land as `pending_authorization`. They do not run yet.

## Authorizing items

The operator clicks **Authorize all items** (queue-level) or **Authorize** (per-item). The action calls `evaluateExecutionAuthorization()` from the weekly-contract engine, persists the result to `execution_authorizations`, attaches the resulting authorization ID to the item, walks the state machine, and writes the log entries.

Allowed items land as `completed` (dry-run shortcut). Soft-blocked items go to `backlogged` or `skipped`. Hard-blocked items go to `blocked`.

## Lifecycle controls

- **Pause queue** — `ready | running → paused`. Items can be paused individually; the queue is the umbrella.
- **Resume queue** — `paused → ready`.
- **Cancel queue** — any non-terminal → `cancelled`. Items keep their last status; the queue stops accepting authorization calls.

All three log to `execution_logs` and write an activity event to the activity stream.

## Item attempt counting

Every authorization run starts an `execution_attempts` row at attempt number `item.attempt_count + 1` and bumps the counter. `evaluateRetry` checks the counter against `max_attempts` (default 3) before scheduling another attempt.

## See also

- [./execution-engine.md](./execution-engine.md)
- [./execution-state-machine.md](./execution-state-machine.md)
- [./execution-logs.md](./execution-logs.md)
