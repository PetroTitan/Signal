# Operation approval UI

`/settings/mcp` surfaces two views of the `mcp_operation_runs` table:

1. **Pending MCP approvals** — rows with `status = pending_approval`, with Approve / Reject buttons.
2. **Operation runs** — the recent audit trail, showing every status.

This document covers what those buttons do and how to extend them.

## Pending approvals

A row lands in `pending_approval` when:

- the runner decides an operation needs operator sign-off before executing, or
- an operation was created with `initialStatus: "pending_approval"` from another surface.

The page lists each row with:

- the operation label (from `MCP_OPERATION_LABELS`)
- risk level + approval mode
- `input_summary` if present
- `created_at`

Two controls:

- **Approve** — calls `approveMcpOperationAction`, which sets `status='approved'`, writes `approved_by` and `approved_at`. Returns `ActionResult<{runId}>`.
- **Reject** — calls `rejectMcpOperationAction`, which sets `status='rejected'` and writes the optional reason to `error_summary`.

Both server actions go through the standard `getPrimaryWorkspace()` membership check, so they respect RLS automatically. The repository update fails closed if the row is not visible.

## Operation runs table

The recent runs section shows the last 20 rows for the workspace. Columns:

- Operation
- Status (`draft | pending_approval | approved | running | completed | failed | rejected | blocked`)
- Risk level
- Approval mode
- Created
- Approved at
- Result (output summary, or error summary in red)

This is read-only. The table is the source of truth for "what happened" and is also linked from `activity_events.operation_id` so the activity stream shows the same events.

## Extending the controls

The current UI implements Approve and Reject only. Two extensions are likely next:

- **Re-run** — for `failed` rows where the operator wants to retry. Will require a server action that opens a fresh run rather than re-using the failed one (history is append-only).
- **Inline diff / preview** — for `pending_approval` rows where the operation type has a structured payload (e.g. a migration plan). Today the page shows `input_summary`; a richer view would render the payload using the operation-specific report renderer in `operation-report.ts`.

Both extensions belong in `_actions.ts` and `_approval-controls.tsx`; do not push business logic into the page component.

## Refusal cases

The page must refuse to render an Approve button for:

- operation types with `approval_mode = 'blocked'` (handled by the repository — the row should never have landed in `pending_approval` in the first place)
- operation types with `approval_mode = 'explicit_text_confirmation_required'` until a confirmation-phrase variant of `approveMcpOperationAction` is implemented (today this is enforced by docs only; harden it before connecting the apply-migration path).

## See also

- [./mcp-connector-ui.md](./mcp-connector-ui.md)
- [./check-runner.md](./check-runner.md)
- [./approval-gated-operations.md](./approval-gated-operations.md)
