# Approval-gated operations

The operation runner refuses to invoke any operation marked `approval_required` or `explicit_text_confirmation_required` without an approval record. This doc describes the lifecycle.

## Lifecycle

```
draft  →  pending_approval  →  approved  →  running  →  completed
                          ↘                          ↘
                           rejected                    failed
                          ↘
                           blocked  (policy)
```

The status column lives in `public.mcp_operation_runs.status` with a CHECK constraint that mirrors the runner's `OperationRunStatus` union.

## When the runner opens a run

`runOperation()` consults `evaluateApproval()` first:

- `no_approval_needed` → status `running`, body executes.
- `approval_required` and no `approvedBy` → status `pending_approval`, body **does not** execute. The runner returns a `blocked_by_policy` result and the caller persists the run as pending.
- `approval_required` with `approvedBy` → status `approved`, body executes.
- `explicit_text_confirmation_required` → must include both `approvedBy` and a matching `confirmationPhrase`. Otherwise status is `pending_approval`.
- `blocked` → status `blocked`. Body never runs.

## What `approvedBy` represents

The UUID of the user who clicked Approve in the UI (or typed the confirmation phrase). For ops that originate from Claude / Codex over MCP, the approval must always come from the workspace member, never from the AI.

## Persistence

Two repository helpers in `src/repositories/admin-operations/mcp-operation-repository.ts`:

- `openOperationRun({ workspaceId, operationType, initialStatus, inputSummary, metadata })` — inserts a row with the risk and approval mode derived from `OPERATION_PERMISSIONS`. The row sits at the chosen status until the user acts.
- `approveOperationRun({ workspaceId, runId, approvedBy })` — marks the row `approved` and records `approved_at` / `approved_by`.
- `closeOperationRun({ workspaceId, runId, status, outputSummary, errorSummary, metadata })` — moves a row to `completed`, `failed`, `rejected`, or `blocked`.

All workspace-scoped RLS. No service-role key.

## Linking approval events to artifacts

When an operation writes a record (e.g. a product), `activity_events.operation_id` references the run, and `activity_events.review_status` records the lifecycle stage that was emitted. That gives the activity feed enough context to render "Product 'Acme' created (pending review)" without joining anything.

## Example flows

### Suggest product (no approval)

1. Caller invokes `runOperation({ operationType: "product_profile_suggest", execute })`.
2. Runner: decision `no_approval_needed`, status `running`.
3. Body produces an extraction object.
4. Caller persists nothing — this is an in-memory suggestion. Optionally writes an `mcp_operation_runs` row with the summary.

### Confirm imported product (approval required)

1. Import landed earlier as `review_status = pending_review`.
2. User clicks Confirm.
3. Action invokes `runOperation({ operationType: "product_profile_confirm", approval: { approvedBy: user.id }, execute: () => updateProductReviewStatus(...) })`.
4. Runner: decision `approval_provided`, status `approved` → body runs.
5. Caller writes `output_summary` and closes the run as `completed`.

### Apply migration (text confirmation required)

1. Claude / Codex prepares a migration file locally and runs checks.
2. The user is shown the diff plus the expected confirmation phrase (e.g. workspace slug or project ref).
3. The user types the phrase and clicks Apply.
4. `runOperation({ operationType: "migration_apply_request", approval: { approvedBy: user.id, confirmationPhrase: typed, expectedPhrase: workspaceSlug } })`.
5. If the phrase matches: body runs (applies migration via Supabase MCP). Otherwise status stays `pending_approval`.

## Hard rule

The runner does not lower an approval mode. If `OPERATION_PERMISSIONS` says `production_impacting / approval_required`, no caller can ask the runner to run it without an approver — not even with a service-role key (the codebase contains no service-role-key path at all).

## See also

- [./operation-risk-model.md](./operation-risk-model.md)
- [./safe-db-operations.md](./safe-db-operations.md)
