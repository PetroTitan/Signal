# Check runner

The check runner section on `/settings/mcp` lets the operator invoke read-only diagnostics in one click. Each entry comes from `_check-catalog.ts`.

## Catalog entry shape

```ts
interface McpCheckDef {
  key: string;
  label: string;
  description: string;
  operationType: McpOperationType | null;
  wired: boolean;
}
```

- `operationType` — the MCP operation that runs when invoked. `null` for documentation-only stubs.
- `wired` — whether a real implementation is connected.

If `wired === false`, the button renders disabled with the text **"Prepared, not connected"**. The UI never claims success without a real execution.

## Today's wired checks

| Key                | Wired | What it does |
| ------------------ | ----- | ------------ |
| `smoke_test_run`   | yes   | Reads workspaces / products / accounts / activity_events under the current user. No writes. |
| All others         | no    | Catalog stub. See below. |

The smoke test calls `runWorkspaceSmokeTest()` (from `src/repositories/admin-operations/smoke-test-operations.ts`), which already opens and closes an `mcp_operation_runs` row, logs the result, and returns a structured `McpOperationResult`.

## Stubs that still need a wiring

These exist as `operationType` entries but have no execution path yet:

- `env_check`
- `auth_check`
- `db_integrity_check`
- `rls_check`
- `route_protection_check`
- `demo_boundary_check`
- `pr_readiness_check`
- `production_smoke_test`

Each needs:

1. a repository helper that performs the check using only `safe_read` operations,
2. a branch in `runMcpCheckAction` that calls it,
3. flipping `wired: true` in the catalog.

The action layer at `src/app/(app)/settings/mcp/_actions.ts` is the only place that should branch on `operationType` — keep the page and the components dumb.

## Risk badges

Every check shows its risk level and approval mode pulled from
`OPERATION_PERMISSIONS`. That's a single source of truth; if the
catalog disagrees with `operation-permissions.ts`, the permission table
wins.

## See also

- [./mcp-connector-ui.md](./mcp-connector-ui.md)
- [./operation-approval-ui.md](./operation-approval-ui.md)
- [./mcp-operations-policy.md](./mcp-operations-policy.md)
