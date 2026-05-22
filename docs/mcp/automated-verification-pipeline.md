# Automated verification pipeline

Phase E2.5 replaces the manual "click each check" pattern with a single one-button verification pipeline. Claude / Codex / MCP can run it, the operator approves the run, and the pipeline produces one structured report with a PR-readiness verdict.

## What runs

In order:

1. **Environment check** — Supabase env resolves; reports OAuth + token-encryption configuration.
2. **Auth check** — session valid; workspace membership exists.
3. **RLS check** — probes every workspace-scoped table; fails if any row's `workspace_id` leaks across the membership boundary.
4. **Database integrity check** — counts workspace-scoped rows; probes `execution_items` for orphan queue / contract references.
5. **Route protection check** — static check that `middleware.ts` fails closed and `(app)/layout.tsx` enforces auth + membership.
6. **Demo boundary check** — confirms the engine safety envelope refuses demo workspaces and that the contract evaluator returns `demo_mode_blocked`.
7. **Production smoke test** — reuses the Phase E0 `runWorkspaceSmokeTest`.
8. **End-to-end execution dry-run** — see [./e2e-smoke-tests.md](./e2e-smoke-tests.md).
9. **PR readiness gate** — aggregates the verdict. See [./pr-readiness-gate.md](./pr-readiness-gate.md).

Each check returns:

```ts
interface CheckResult {
  check: string;
  label: string;
  status: "pass" | "warning" | "fail";
  summary: string;
  details: string[];
  requiresUserAction: boolean;
  blocksMerge?: boolean;
  durationMs: number;
}
```

## How to run

`/settings/mcp` has a **Run full verification pipeline** button at the top. Clicking it calls `runVerificationPipelineAction`, which:

1. Opens an `mcp_operation_runs` row (status `running`).
2. Walks the checks in order.
3. Walks the E2E smoke pipeline (tagged with `verification_run_id`).
4. Computes the PR-readiness verdict.
5. Closes the operation run with `completed` or `failed`.
6. Writes a `verification.pipeline_completed` activity event.
7. Returns the structured report to the UI.

The UI renders a per-check row with status + summary + details, plus the verdict at the top.

## Per-check buttons

The catalog below the pipeline button lets the operator run individual checks. Each one writes its own `mcp_operation_runs` row so the audit trail is still complete.

## Safety

- All test data is tagged with `metadata.verification_run_id` / `metadata.e2e_run_id`.
- The E2E pipeline cleans up after itself: products and accounts archive; plan items mark skipped; contracts revoke; queues / items cancel. Logs and attempts are append-only and stay in place, filterable by metadata.
- The pipeline never calls an external platform API.
- The runner runs as the operator's session — no service-role bypass.
- Failures still run cleanup so test rows do not pollute real reads.

## See also

- [./pr-readiness-gate.md](./pr-readiness-gate.md)
- [./e2e-smoke-tests.md](./e2e-smoke-tests.md)
- [./mcp-connector-ui.md](./mcp-connector-ui.md)
- [./check-runner.md](./check-runner.md)
