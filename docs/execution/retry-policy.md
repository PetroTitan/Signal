# Retry policy

`evaluateRetry(input)` decides whether a failed attempt should be retried, and on what cadence.

## Inputs

```ts
interface RetryPolicyInput {
  item: ExecutionItem;
  lastOutcome: "succeeded" | "failed" | "blocked" | "skipped";
  transient?: boolean;
}
```

## Decision

- `succeeded` / `skipped` → no retry; the item is done.
- `blocked` → no retry. A hard block from the contract layer is not going to change on the next attempt.
- `failed` → retry only if both:
  - `attempt_count < max_attempts` (default `max_attempts = 3`), and
  - the caller flagged the failure as `transient` (timeout, network glitch, brief 5xx).
- Non-transient failures surface to the operator; the engine does not retry blindly.

## Backoff

```
attempt 1 → 30 seconds
attempt 2 → 2 minutes
attempt 3 → 5 minutes
```

Phase E2 has no background scheduler — these delays are advisory and surface in `RetryDecision.delayMs`. The UI displays the suggestion; the operator decides when to re-run.

## When the budget is exhausted

The item stays in `failed` with the last `error_summary` on its most recent `execution_attempts` row. The operator can:

- adjust the item (edit the source plan item, then re-queue), or
- mark the item `cancelled` from the queue detail page, or
- bump `max_attempts` on a per-item basis through the repository (not exposed in the UI today).

## See also

- [./execution-engine.md](./execution-engine.md)
- [./execution-logs.md](./execution-logs.md)
