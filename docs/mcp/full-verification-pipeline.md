# Full verification pipeline

Phase E2.6 extends the E2.5 pipeline with three new safety checks. The full sequence is now:

1. `env_check`
2. `auth_check`
3. `rls_check`
4. `db_integrity_check`
5. `route_protection_check`
6. `demo_boundary_check`
7. `weekly_contract_check` *(new)*
8. `execution_safety_check` *(new)*
9. `oauth_safety_check` *(new)*
10. `production_smoke_test`
11. `execution_dry_run_smoke` (full E2E)
12. `pr_readiness_check`

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

## Final verdict

`summarizePrReadiness(results)` returns:

- **ready_to_merge** — every check passed.
- **needs_review** — at least one warning or non-blocking fail.
- **blocked** — at least one check with `blocksMerge=true` failed.

## Blocking checks (Phase E2.6)

| Check | Blocks merge? |
| --- | --- |
| env_check | no |
| auth_check | **yes** |
| rls_check | **yes** |
| db_integrity_check | **yes** |
| route_protection_check | **yes** |
| demo_boundary_check | **yes** |
| weekly_contract_check | **yes** |
| execution_safety_check | **yes** |
| oauth_safety_check | **yes** |
| production_smoke_test | no |
| execution_dry_run_smoke | **yes** |
| pr_readiness_check | **yes** |

The intuition: anything that touches auth, RLS, data integrity, contract policy, or execution / OAuth safety is a blocker. Configuration probes raise warnings but don't block.

## Audit

The pipeline writes a single `mcp_operation_runs` row at the top, walks the checks, then closes the row with the verdict. A `verification.pipeline_completed` activity event mirrors the final state. The E2E dry-run also records its own tagged authorization rows, logs, and attempts — see [./e2e-smoke-tests.md](./e2e-smoke-tests.md).

## See also

- [./automated-verification-pipeline.md](./automated-verification-pipeline.md)
- [./e2e-smoke-tests.md](./e2e-smoke-tests.md)
- [./pr-readiness-gate.md](./pr-readiness-gate.md)
- [./runtime-checks.md](./runtime-checks.md)
