# Operation risk model

Every MCP-driven operation in Signal maps to exactly one risk level and one approval mode. The runner uses this table to decide whether to execute, gate, or refuse the call.

## Risk levels

| Risk level | Meaning |
| --- | --- |
| `safe_read` | Inspection only. No DB writes; no user-visible external I/O. Lint, typecheck, build, smoke tests, schema reads, suggestion generation. |
| `local_write` | Writes to the local working tree (drafts, prepared migrations, generated docs). No remote effects. |
| `remote_write` | Writes to remote systems that are reversible: pending DB records, branch pushes, preview-env edits. |
| `production_impacting` | Touches production: confirmed data writes, applied migrations, PR merges, production redeploys, scheduled-execution enablement. |
| `blocked` | Never executes from MCP. Listed so the policy is self-documenting in code. |

## Approval modes

| Mode | Behavior |
| --- | --- |
| `no_approval_needed` | Runs immediately. The runner still writes an `mcp_operation_runs` audit row. |
| `approval_required` | Lands in `pending_approval`. The user clicks Approve, then it runs. The runner records the approver. |
| `explicit_text_confirmation_required` | Same as above, but the user must type a confirmation phrase (e.g. the project name). Reserved for the most destructive operations — e.g. `migration_apply_request` against production. |
| `blocked` | The runner refuses to even record an attempt. Used for operations that should never be offered. |

## Operation × risk matrix

The canonical table lives in `OPERATION_PERMISSIONS` in `src/core/mcp-operations/operation-permissions.ts`. The rendered version is on `/settings/mcp` — that page reads the same constants, so they cannot drift.

Summary:

| Operation | Risk | Approval |
| --- | --- | --- |
| `*_suggest` (product, account, weekly plan) | safe_read | none |
| `smoke_test_run`, `db_integrity_check`, `rls_check`, `pr_readiness_check`, `deployment_readiness_check`, `production_smoke_test` | safe_read | none |
| `migration_plan_prepare` | local_write | none |
| `*_create_pending`, `screenshot_*_import` | remote_write | approval_required |
| `*_confirm` (product, account) | production_impacting | approval_required |
| `migration_apply_request` | production_impacting | explicit_text_confirmation_required |

## Adding a new operation

1. Add the literal to `MCP_OPERATION_TYPES`.
2. Add a `MCP_OPERATION_LABELS` entry.
3. Add a row in `OPERATION_PERMISSIONS`.
4. Update the Postgres CHECK constraint in a new migration if the new operation should be writable into `mcp_operation_runs.operation_type`.
5. Update [`mcp-operations-policy.md`](./mcp-operations-policy.md) and `/settings/mcp` will pick up the change automatically.

## Why split create into `_pending` + `_confirm`

AI-driven create flows always land as `review_status = pending_review`. Promoting to `confirmed` is a separate, audit-trailed operation that requires user approval. This keeps the user as the gating step on every record that downstream systems (scheduler, publisher) might act on.

## See also

- [./approval-gated-operations.md](./approval-gated-operations.md)
- [./safe-db-operations.md](./safe-db-operations.md)
