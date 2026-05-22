# MCP operations policy

The hard policy boundary for what Claude / Codex / MCP-connected tools may do inside Signal. The user is always the final approver for anything that touches production or external state.

## Three layers

1. **Allowed with no extra approval** — inspection, analysis, drafts, local checks.
2. **Allowed after explicit user approval** — anything that touches remote state, production data, or merges code.
3. **Blocked entirely** — anything that would impersonate the user externally, store secrets, or bypass platform safety systems.

The exhaustive lists live in code (`src/core/mcp-operations/operation-policy.ts`) so the docs and the runtime never diverge.

## No approval needed

- Inspect repository contents and types.
- Read Supabase schema, RLS policies, and row counts via MCP.
- Run `lint` / `typecheck` / `build` locally.
- Suggest product or account fields from a prompt or screenshot.
- Prepare draft code, draft docs, draft migration files.
- Run smoke tests, DB integrity checks, RLS checks, PR-readiness checks.

These produce reports, drafts, or in-memory suggestions only. No remote state changes.

## Requires user approval

- Apply Supabase migrations to the remote project.
- Modify production data.
- Push commits to a remote branch.
- Open or merge a pull request.
- Trigger a production redeploy.
- Promote a screenshot-imported account or product from `pending_review` to `confirmed`.
- Enable scheduled execution of a weekly plan.

The operation runner refuses these unless an approval record is attached. See [`approval-gated-operations.md`](./approval-gated-operations.md).

## Blocked

- Create external social accounts on the user's behalf.
- Log into Reddit / X / LinkedIn through any browser-automation path.
- Store passwords, cookies, session tokens, 2FA codes, or recovery codes.
- Bypass platform safety systems (no anti-detect, no fingerprint spoofing, no proxy rotation).
- Publish, post, or comment without an explicit approved workflow.
- Modify payment or billing configuration.
- Read or use the Supabase service-role key from the client.

The screenshot extractor encodes the "never extract" list as `NEVER_EXTRACT_FIELDS` in `screenshot-import-contracts.ts`.

## Where this lives in code

- Policy text constants: `src/core/mcp-operations/operation-policy.ts`.
- Operation enum: `operation-types.ts`.
- Per-operation risk + approval: `operation-permissions.ts`.
- Approval gate: `approval-gates.ts`.
- Runner: `operation-runner.ts`.
- Audit table: `mcp_operation_runs` (workspace-scoped RLS).

## See also

- [./operation-risk-model.md](./operation-risk-model.md)
- [./approval-gated-operations.md](./approval-gated-operations.md)
- [./claude-codex-workflow.md](./claude-codex-workflow.md)
