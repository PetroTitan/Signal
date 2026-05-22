# GitHub / Vercel / Supabase operations

How Claude / Codex interact with the three external services Signal currently depends on, and where the approval gates live.

## GitHub

| Operation | Risk | Approval | Notes |
| --- | --- | --- | --- |
| Read repo state, list PRs / issues, view diffs | safe_read | none | Inspection only. |
| Prepare commit message and diff locally | local_write | none | The file is in the working tree, not on the remote. |
| Push a branch | remote_write | approval_required | Default behavior: ask the user before `git push`. |
| Open a PR | remote_write | approval_required | Ask before `gh pr create`. |
| Merge a PR | production_impacting | approval_required | Never without explicit user click. |
| Force push to main / master | blocked | blocked | The runner refuses. |
| Edit GitHub Actions / branch protection | production_impacting | explicit_text_confirmation_required | Reserved for the rare operator-initiated case. |

The user already merges PRs through GitHub's UI today; Codex / Claude opens the PR and waits.

## Vercel

| Operation | Risk | Approval | Notes |
| --- | --- | --- | --- |
| Inspect projects, deployments, env (presence only) | safe_read | none | Never reads secret values. |
| Read build logs | safe_read | none | |
| Trigger a preview redeploy | remote_write | approval_required | Used after env changes. |
| Trigger a production redeploy | production_impacting | approval_required | Always asks first. |
| Modify env vars | production_impacting | explicit_text_confirmation_required | Confirmation phrase = the env var name. |
| Modify domain / SSL config | production_impacting | explicit_text_confirmation_required | |
| Delete a project | blocked | blocked | The runner refuses. |

Env-variable changes do not apply to existing deployments. The redeploy step is its own approval-gated operation; the runner records both events separately.

## Supabase

| Operation | Risk | Approval | Notes |
| --- | --- | --- | --- |
| `list_tables`, `list_migrations`, `execute_sql` (read) | safe_read | none | Inspection only. |
| `execute_sql` writes (one-off fixups) | remote_write | approval_required | Discouraged. Prefer a migration file. |
| Prepare migration file locally | local_write | none | |
| `apply_migration` to remote project | production_impacting | explicit_text_confirmation_required | Confirmation phrase = the project ref. |
| Rotate keys / change auth settings | production_impacting | explicit_text_confirmation_required | |
| Use service-role key from client | blocked | blocked | The codebase has no service-role-key import path. |

The `apply_migration` flow always:

1. Writes the migration to `supabase/migrations/` first (local_write).
2. Shows the user the SQL.
3. Shows the user the project ref and asks them to type it.
4. Calls `mcp__claude_ai_Supabase__apply_migration` only after the phrase matches.

## What this means for Claude / Codex

When you, the model, want to perform one of these:

1. **Prepare the change locally.** Write files, run checks, generate diffs.
2. **Surface a report.** Quote the diff. State the operation type and risk level. List what's reversible.
3. **Ask explicitly.** "Apply this migration to project `kcaxqzbnrxzqisewbdkf`? Type the project ref to confirm."
4. **Only then run the MCP tool.**

If the user declines or asks for changes, mark the run as `rejected` (or `needs_edit`) and start over.

## See also

- [./approval-gated-operations.md](./approval-gated-operations.md)
- [./safe-db-operations.md](./safe-db-operations.md)
