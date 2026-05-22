# Safe DB operations

Rules every MCP-driven DB interaction obeys.

## The single rule

Every write performed by an MCP operation must:

1. Run under the **user's session** (cookies-aware Supabase server client).
2. Be **workspace-scoped** by RLS (the server function never invents a `workspace_id`).
3. Default to **`review_status = pending_review`** unless the user already confirmed.
4. Tag itself with **`source`** so the activity feed and reports can tell hand-entered rows from AI-assisted ones.
5. Write a corresponding **`mcp_operation_runs`** row when the operation goes through the runner.

The codebase has no service-role-key path. There is no escape hatch.

## Anatomy of a safe operation

```ts
import { runOperation } from "@/core/mcp-operations";
import { openOperationRun, closeOperationRun } from "@/repositories/admin-operations";

// 1. Open the audit row up front so we always have a trace, even on
//    failure.
const run = await openOperationRun({
  workspaceId,
  operationType: "screenshot_product_import",
  initialStatus: "draft",
  inputSummary: "Screenshot of acme.example landing page",
});

// 2. Hand off to the runner. The body only executes if the approval
//    gate clears.
const { status, result, outputSummary } = await runOperation({
  operationType: "screenshot_product_import",
  inputSummary: run.inputSummary,
  approval: { approvedBy: user.id }, // approval_required path
  execute: async () => importProductFromScreenshot(input, { confirmedByUser: false }),
  describeOutput: (payload) => `Imported product ${payload.payload.productId} as ${payload.payload.reviewStatus}`,
});

// 3. Close the run with the final status.
await closeOperationRun({
  workspaceId,
  runId: run.id,
  status,
  outputSummary,
  errorSummary: result && !result.ok ? result.error : null,
});
```

## What about read-only operations?

`safe_read` operations (smoke tests, schema reads, suggestion generation) still produce an `mcp_operation_runs` row — that's the audit trail. They just skip the approval gate.

## RLS invariants

Every Phase E0 table has RLS:

- `mcp_operation_runs`: select / insert / update gated by `is_workspace_member`. No delete. Insert also checks `actor_user_id = auth.uid()` when set.
- `products.source` / `products.review_status`: same workspace-scoped policies as the rest of `products`. The `source` column is a CHECK-constrained enum.
- `growth_accounts.source` / `review_status`: same.
- `activity_events.source` / `operation_id` / `review_status`: same.

## Pending-review records are inactive

Downstream systems (scheduler, publisher, weekly-plan composer) must filter `review_status = 'confirmed'`. Pending records exist for audit; they never feed action.

Today: the `listProducts` and `listAccounts` repository helpers do not yet filter by `review_status`. When the import assistant ships its UI, the lists should add the filter (or display badges) so confirmed and pending records are visually distinct. Documented as a follow-up.

## Migrations are also gated

Applying a Supabase migration from MCP requires:

- The migration file written locally (`local_write`).
- A migration plan prepared and shown to the user (`migration_plan_prepare`).
- User typing the project ref or workspace slug as the confirmation phrase (`explicit_text_confirmation_required`).

Only then does the runner call `mcp__claude_ai_Supabase__apply_migration`.

## See also

- [./approval-gated-operations.md](./approval-gated-operations.md)
- [./github-vercel-supabase-ops.md](./github-vercel-supabase-ops.md)
