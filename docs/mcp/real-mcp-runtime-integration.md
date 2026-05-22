# Real MCP runtime integration

Phase E2.6 turns the MCP layer from an informational surface into an operational runtime. The pieces that already existed — operation runs, approval gates, the verification pipeline — gain a real runtime model (`src/core/mcp-runtime/`), three new safety checks, an explicit-text confirmation flow for production-impacting operations, and a working intake on `/imports`.

## What changed

- `src/core/mcp-runtime/` — typed runtime model: assistant kinds, extended connector statuses (`auth_failed`, `capability_mismatch`, `version_mismatch`), per-connector capability matrix, health derivation, policy strings.
- Three new pipeline checks: `oauth_safety_check`, `execution_safety_check`, `weekly_contract_check` (all `blocksMerge=true`).
- `/settings/mcp` connector status section reads from the new runtime model instead of the static Phase E0 list.
- `/imports` now has working textareas + a `Prepare extraction` action that records an `mcp_operation_runs` row with `status='pending_approval'` and writes a `import.requested` activity event.
- `approveMcpOperationAction` enforces an explicit confirmation phrase for operations with `approval_mode='explicit_text_confirmation_required'`. The phrase is `approve production operation <run_id>` (deterministic so the operator can't approve the wrong run by accident).

## What did not change

- No autonomous publishing.
- No external account creation.
- No browser automation, no password/cookie/session handling.
- No service-role key exposure.
- No bypassing of weekly contracts.
- Real connection detection is still not implemented — every connector still reports `placeholder` or `manual` honestly. The runtime model just gives Signal somewhere to put a `connected` value when probes ship.

## Loop

```
Claude / Codex prepares
  → Signal records mcp_operation_runs row
  → check runs append output_summary
  → report generated (verification pipeline)
  → user approves or rejects
  → only approved action proceeds
```

## See also

- [./connector-health-checks.md](./connector-health-checks.md)
- [./full-verification-pipeline.md](./full-verification-pipeline.md)
- [./runtime-checks.md](./runtime-checks.md)
- [./import-runtime-preparation.md](./import-runtime-preparation.md)
- [./approval-gated-runtime.md](./approval-gated-runtime.md)
