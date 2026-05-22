# Contract authorization in the execution engine

Every execution item must pass through the weekly-contract evaluator before it can run. The execution engine does **not** ship its own approval logic — it borrows the one from `src/core/weekly-contract/contract-evaluator.ts`.

## The call path

1. The operator clicks **Authorize** or **Dry-run** on an item (or **Authorize all** / **Dry-run queue** at the queue level).
2. `_actions.ts` calls `getActiveContract(workspaceId)` and `assertEngineSafetyEnvelope(...)`.
3. The action loads the cadence snapshot via `loadCadenceSnapshotForContract(...)`.
4. `planDryRunForItem(input)` (pure) returns:
   - `authorization: AuthorizationResult`
   - `dryRun: DryRunOutcome`
   - `nextStatus: ExecutionItemStatus`
   - `logs: ComposedLog[]`
5. The action persists the authorization row via `recordExecutionAuthorization(...)`, attaches the resulting ID to the item via `attachAuthorization(...)`, writes all composed logs through `recordLogs(...)`, walks the item state machine, and finishes the `execution_attempts` row.

There is no path that skips step 4. Every state change is preceded by an evaluator decision.

## What `assertEngineSafetyEnvelope` adds

A second, redundant guard. Even if the contract evaluator returns `allow`, the safety envelope refuses:

- demo workspaces
- non-active contracts
- background-runner or external-publish invocations (Phase E2 only permits `operator_dry_run`)

This is defense in depth. The contract evaluator already enforces the first two; the safety guard catches "wrong invocation kind" — the kind of mistake a future PR could introduce by wiring a background worker too early.

## When `allow` becomes `completed`

In dry-run mode, an `allow` verdict is treated as the whole transaction. The state walks `pending_authorization → authorized → completed` in a single action, and the dry-run log message describes what *would* have happened.

When real publishing arrives, the runner should split:

- `allow` → walk `pending_authorization → authorized → running`
- on a successful publish → walk `running → completed`
- on a failure → walk `running → failed` and consult `evaluateRetry`

The dry-run shortcut is documented in [./execution-state-machine.md](./execution-state-machine.md).

## Denial paths

- **hard_block** → item moves to `blocked`. Operator must adjust the contract or the item before re-attempting.
- **soft_block + shouldBacklog=true** → item moves to `backlogged`. Operator can rotate it back manually.
- **soft_block + shouldBacklog=false** → item moves to `skipped`. The item is recorded as "we deliberately did not act on this."

Every denial writes an `item.authorization_denied` log entry with the reason code and reason detail.

## See also

- [../contracts/execution-authorization.md](../contracts/execution-authorization.md) — the contract-side view
- [./execution-engine.md](./execution-engine.md)
- [./dry-run-mode.md](./dry-run-mode.md)
