# Claude / Codex / MCP workflow

The operating model when Claude Code, Codex, or an MCP-connected client is helping with Signal's day-to-day product and dev work.

## The seven steps

1. **Inspect.** Read source, types, tables, RLS, route list, recent commits.
2. **Prepare draft.** Generate code, docs, migrations, or extraction mappings locally. Nothing remote yet.
3. **Run checks.** `lint`, `typecheck`, `build`, smoke tests, DB integrity check, RLS check, PR-readiness check. Aggregate into an `OperationCheckReport`.
4. **Report.** Surface the checks + the proposed change to the user. Quote diffs. Quote diagnostic output.
5. **User approves.** Click Approve, or type the confirmation phrase if the operation requires it.
6. **Apply.** The runner executes the approved action — push branch, apply migration, mark record confirmed, etc.
7. **Log.** Signal writes the `mcp_operation_runs` row and the linked `activity_events`. The user can always reconstruct what happened.

## What the user does

Mostly four things:

- **Review** the proposed change.
- **Approve** it, **reject** it, or **request changes**.
- **Type confirmation phrases** for the most destructive operations.
- **Read activity** to confirm everything went as expected.

That's it. The expectation is the user does *not* do CRUD work by hand for product / account setup once the import assistant is wired up.

## What Claude / Codex does

- Walks the codebase.
- Calls Supabase MCP for read-only inspection.
- Drafts code, docs, migrations.
- Runs checks via the registered MCP tools (or local `npm` scripts).
- Prepares PR text.
- Stops at every irreversible boundary and asks.

## What's never delegated

- External account creation. Signal never opens a Reddit / X / LinkedIn signup flow on the user's behalf.
- Login automation. Signal never types credentials anywhere.
- Storing secrets. The codebase has no service-role-key path.
- Publishing without a confirmed contract. The scheduler will not act on `pending_review` records.

## Communicating decisions

When the AI proposes an operation, the report should include:

- The operation type (one of `MCP_OPERATION_TYPES`).
- The risk level and approval mode.
- A one-line `input_summary` (safe to log).
- Expected `output_summary`.
- Whether it's reversible.
- Whether it touches production.

The same fields land in the `mcp_operation_runs` row when the operation executes, so the audit trail mirrors the proposal.

## Recovery

If a `production_impacting` operation goes wrong:

- Reversible: the runner records `failed` status and the user can ask Claude / Codex to roll back.
- Irreversible (e.g. applied migration): the user has the SQL of the migration in the PR, plus the activity log. Recovery is a forward migration, not a magic undo.

The runner refuses to mark `reversible: false` operations as `no_approval_needed`. That invariant is enforced in `OPERATION_PERMISSIONS` and reviewable on `/settings/mcp`.

## See also

- [./approval-gated-operations.md](./approval-gated-operations.md)
- [./safe-db-operations.md](./safe-db-operations.md)
- [./github-vercel-supabase-ops.md](./github-vercel-supabase-ops.md)
