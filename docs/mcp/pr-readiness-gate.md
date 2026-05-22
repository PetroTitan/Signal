# PR readiness gate

The PR readiness gate aggregates the verification checks into one of three verdicts:

- **ready_to_merge** — every check passed.
- **needs_review** — at least one warning or non-blocking fail. A human should look before merging.
- **blocked** — at least one check that blocks merge has failed.

## Which checks block

`CHECK_BLOCKS_MERGE` in `src/core/verification/check-catalog.ts` is the single source of truth.

| Check | Blocks merge? |
| --- | --- |
| `env_check` | no |
| `auth_check` | **yes** |
| `rls_check` | **yes** |
| `db_integrity_check` | **yes** |
| `route_protection_check` | **yes** |
| `demo_boundary_check` | **yes** |
| `execution_dry_run_smoke` | **yes** |
| `production_smoke_test` | no |
| `pr_readiness_check` | **yes** |

The intuition: anything that touches the auth / RLS / data-integrity / dry-run boundary is a blocker. Things that report on configuration state (`env_check`, `production_smoke_test`) raise warnings but don't block.

## Verdict logic

```ts
export function summarizePrReadiness(results) {
  if (any fail with blocksMerge=true) return "blocked";
  if (any warning or non-blocking fail)  return "needs_review";
  return "ready_to_merge";
}
```

## How the gate is surfaced

The pipeline action returns a `prVerdict` field that the UI renders at the top of the verification report. The verdict is also written to:

- `mcp_operation_runs.metadata.verdict`
- the `verification.pipeline_completed` activity event metadata

## Branch-level use

The gate is per-run, not per-branch. A future phase can wire it to a CI check that calls the pipeline endpoint and fails the build when verdict is `blocked`. Until then the gate is a human-readable verdict on `/settings/mcp`.

## See also

- [./automated-verification-pipeline.md](./automated-verification-pipeline.md)
- [./e2e-smoke-tests.md](./e2e-smoke-tests.md)
