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

## Today's wired checks (Phase E2.5)

| Key | Wired | What it does |
| --- | --- | --- |
| `smoke_test_run` | yes | Reads workspaces / products / accounts / activity_events under the current user. No writes. |
| `env_check` | yes | Supabase env resolves; reports OAuth + token-encryption configuration. |
| `auth_check` | yes | Session valid; workspace membership exists. |
| `rls_check` | yes | Probes every workspace-scoped table; fails on cross-workspace leak. |
| `db_integrity_check` | yes | Counts rows and probes `execution_items` for orphan queue / contract refs. |
| `route_protection_check` | yes | Static check that middleware fails closed and `(app)/layout.tsx` guards membership. |
| `demo_boundary_check` | yes | Confirms the engine safety envelope refuses demo workspaces. |
| `execution_dry_run_smoke` | yes | Full E2E pipeline. See [./e2e-smoke-tests.md](./e2e-smoke-tests.md). |
| `pr_readiness_check` | runs inside full pipeline | Aggregates the verdict. |
| `production_smoke_test` | catalog stub | Read-only probe of preview/production endpoints; not connected yet. |

The full pipeline runs every wired check in order and writes a single `mcp_operation_runs` row plus a `verification.pipeline_completed` activity event. See [./automated-verification-pipeline.md](./automated-verification-pipeline.md).

## Adding a new check

1. Add a repository helper in `src/repositories/verification/checks.ts` returning `CheckResult`.
2. Add the key to `VERIFICATION_CHECKS` in `src/core/verification/check-catalog.ts`.
3. Add the dispatch branch in `runSingleCheck` (in `src/repositories/verification/pipeline.ts`).
4. Add the entry to `MCP_CHECKS` in `src/app/(app)/settings/mcp/_check-catalog.ts` with `wired: true`.
5. Decide `CHECK_BLOCKS_MERGE` for the PR-readiness gate.

The action layer at `src/app/(app)/settings/mcp/_actions.ts` is the only place that should branch on the check key — keep the page and the components dumb.

## Risk badges

Every check shows its risk level and approval mode pulled from
`OPERATION_PERMISSIONS`. That's a single source of truth; if the
catalog disagrees with `operation-permissions.ts`, the permission table
wins.

## See also

- [./mcp-connector-ui.md](./mcp-connector-ui.md)
- [./operation-approval-ui.md](./operation-approval-ui.md)
- [./mcp-operations-policy.md](./mcp-operations-policy.md)
