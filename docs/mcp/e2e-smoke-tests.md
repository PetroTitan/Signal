# End-to-end smoke tests

The E2E smoke pipeline walks the full Signal stack from product creation to dry-run execution and back. It is the most expensive verification check and the one most likely to surface integration drift.

## What it covers

```
product   ← createProduct
account   ← createAccount (platform=reddit, planned)
plan      ← createWeeklyPlan
plan_item ← createPlanItem (status=approved)
contract  ← createWeeklyContract → submit → approve → activate
queue     ← createExecutionQueue (status=draft)
exec_item ← createExecutionItem (status=pending_authorization)
auth      ← recordExecutionAuthorization (allow)
attempt   ← startAttempt → finishAttempt(succeeded)
logs      ← recordLogs (5 entries spanning the authorization → dry-run → complete flow)
item      ← updateItemStatus → authorized → completed
verify    ← assert expected event types present in execution_logs
cleanup   ← cancel item / cancel queue / revoke contract / skip plan item /
            archive account / archive product
```

## Tagging

Every entity carries `metadata.e2e_run_id = <uuid>` (and the same value lands on attempts, authorization records, and logs). The pipeline returns the run id to the UI; the operator can grep / filter by it.

The id is also written to:

- `mcp_operation_runs.metadata.verification_run_id`
- the `verification.pipeline_completed` activity event metadata

## Cleanup strategy

Some tables expose deletes (products, accounts) and some are append-only history (logs, attempts, contracts). The pipeline picks the safest available terminal state for each:

| Table | Cleanup |
| --- | --- |
| `products` | `archiveProduct` (status='archived') |
| `growth_accounts` | `archiveAccount` (status='archived') |
| `weekly_plan_items` | status='skipped' |
| `weekly_approval_contracts` | `revokeContract` |
| `execution_queues` | `cancelQueue` |
| `execution_items` | `updateItemStatus` → 'cancelled' |
| `execution_logs` | left in place (append-only); filter by metadata |
| `execution_attempts` | left in place; filter by metadata |
| `execution_authorizations` | left in place; filter by metadata |

## Failure path

A throw at any step short-circuits the pipeline, marks the result as `fail`, **still runs cleanup**, and surfaces the error to the operator. The half-built run is still visible by its tag.

## Why not a separate test workspace

Creating a workspace requires bootstrapping a user, which requires (in dev) impersonation paths we explicitly don't have in production code. Tagging entities and walking the operator's real workspace is the conservative path: the entities are clearly marked and torn down at the end.

A future phase could carve out a per-workspace `verification_mode` flag that hides tagged entities from regular reads. Today the operator just needs to know the pipeline runs against their own workspace.

## See also

- [./automated-verification-pipeline.md](./automated-verification-pipeline.md)
- [./pr-readiness-gate.md](./pr-readiness-gate.md)
- [../execution/execution-engine.md](../execution/execution-engine.md)
- [../contracts/weekly-operating-contract.md](../contracts/weekly-operating-contract.md)
