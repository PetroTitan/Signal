# Execution logs

`execution_logs` is the append-only audit trail. Every state change, authorization decision, and dry-run outcome lands here.

## Event vocabulary

Listed in [src/core/execution-engine/execution-events.ts](../../src/core/execution-engine/execution-events.ts):

```
queue.created
queue.ready
queue.paused
queue.resumed
queue.cancelled
queue.completed
queue.failed
item.queued
item.authorization_requested
item.authorization_allowed
item.authorization_denied
item.scheduled
item.ready
item.dry_run_started
item.dry_run_finished
item.completed
item.blocked
item.backlogged
item.skipped
item.paused
item.resumed
item.failed
item.cancelled
item.retry_scheduled
```

Adding a new event means appending to that array and using the new value through the typed `ExecutionLogEvent` alias — no string literals scattered through the codebase.

## Severities

`debug | info | warning | error`

The repository never derives severity automatically; the composer sets it explicitly. `info` is the default. `warning` marks recoverable conditions (backlogged, skipped, queue paused). `error` is reserved for hard blocks and runner failures.

## Activity stream mirror

Not every log event mirrors to `activity_events`. We keep the activity stream calm and only surface operator-relevant transitions:

```
execution_queue.created
execution_queue.paused
execution_queue.resumed
execution_queue.cancelled
execution_queue.completed
execution_item.queued
execution_item.authorized
execution_item.blocked
execution_item.backlogged
execution_item.dry_run_completed
execution_item.failed
```

## RLS

- `select` — workspace members
- `insert` — workspace members
- `update` — forbidden
- `delete` — forbidden

Logs are history; the database refuses to let the app rewrite them.

## See also

- [./execution-engine.md](./execution-engine.md)
- [./queue-and-items.md](./queue-and-items.md)
