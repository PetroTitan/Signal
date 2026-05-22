# Execution engine

The execution engine is the durable layer that carries out an approved weekly operating contract. It does **not** publish externally in Phase E2 — every action runs in dry-run mode and records what *would* have happened.

## What the engine guarantees

- No active contract → no execution.
- No `allowed` authorization row → no execution.
- No confirmed plan item → no execution.
- No external platform calls (no Reddit / X / LinkedIn / OAuth / browser automation).
- No silent failures — every attempt writes an `execution_attempts` row.
- No raw errors in the UI — repositories throw `RepositoryError`, actions return `ActionResult`.
- Every denial logs the reason code in `execution_logs`.

## The four tables

- `execution_queues` — one row per execution envelope, tied to a weekly contract. Statuses: `draft → ready → running → paused → completed | cancelled | failed`. The partial unique index `execution_queues_one_live_per_contract` enforces at most one non-terminal queue per contract.
- `execution_items` — concrete units the engine evaluates. Statuses: `pending_authorization → authorized → scheduled → ready → running → completed`; or `blocked | backlogged | skipped | paused | failed | cancelled`. Each item references the active contract and (when present) the source `weekly_plan_item`.
- `execution_logs` — append-only audit trail keyed by `event_type` and `severity`. Members can read and insert; updates and deletes are disallowed by RLS.
- `execution_attempts` — append-first per-attempt history. The runner inserts at start, then updates `finished_at` / `status` / `error_summary` after the attempt resolves.

## Module layout

- [src/core/execution-engine/execution-types.ts](../../src/core/execution-engine/execution-types.ts) — canonical types + labels + DryRunAction enum
- [src/core/execution-engine/execution-status.ts](../../src/core/execution-engine/execution-status.ts) — terminal-status helpers
- [src/core/execution-engine/execution-state-machine.ts](../../src/core/execution-engine/execution-state-machine.ts) — explicit transition tables + typed `transitionItem` / `transitionQueue`
- [src/core/execution-engine/execution-safety.ts](../../src/core/execution-engine/execution-safety.ts) — `assertEngineSafetyEnvelope` fail-closed pre-flight
- [src/core/execution-engine/execution-policy.ts](../../src/core/execution-engine/execution-policy.ts) — human-readable policy strings
- [src/core/execution-engine/retry-policy.ts](../../src/core/execution-engine/retry-policy.ts) — `evaluateRetry`
- [src/core/execution-engine/dry-run-executor.ts](../../src/core/execution-engine/dry-run-executor.ts) — pure `dryRunExecute`
- [src/core/execution-engine/execution-events.ts](../../src/core/execution-engine/execution-events.ts) — log + activity event vocabulary
- [src/core/execution-engine/execution-log-composer.ts](../../src/core/execution-engine/execution-log-composer.ts) — pure log composition
- [src/core/execution-engine/execution-runner.ts](../../src/core/execution-engine/execution-runner.ts) — pure `planDryRunForItem` orchestrator

## See also

- [./execution-state-machine.md](./execution-state-machine.md)
- [./dry-run-mode.md](./dry-run-mode.md)
- [./queue-and-items.md](./queue-and-items.md)
- [./retry-policy.md](./retry-policy.md)
- [./execution-logs.md](./execution-logs.md)
- [./contract-authorization.md](./contract-authorization.md)
