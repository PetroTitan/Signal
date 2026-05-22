# Claude Code operator flow

Claude Code runs on the operator's machine. Signal cannot reach into it; the bridge is the contract that lets the two talk safely.

## Step-by-step

1. **Open `/operator-bridge`** in Signal and click **Create bridge request**.
2. Fill in:
   - Title — a one-liner the audit trail will show.
   - Assistant — `claude_code`.
   - Request type — e.g. `repo_check`, `migration_review`, `pr_readiness_review`.
   - Risk level — start at `safe_read` unless you've already approved a higher level on the linked `mcp_operation_runs` row.
   - Task prompt — describe what Claude Code should verify. Be specific.
3. Signal stores the request and mints a nonce. You land on `/operator-bridge/[id]`.
4. Click **Copy prompt** to copy the operator-prompt block to your clipboard.
5. In Claude Code, paste the prompt. Claude Code:
   - Reads only what the prompt allows.
   - Runs the requested checks (`npm run lint` / `typecheck` / `build`, `git status`, etc., depending on the request type).
   - Builds the JSON envelope with the embedded `request_id` and `nonce`.
   - Returns *only* the JSON.
6. Copy the JSON back into the **Submit result** textarea on the bridge page.
7. Signal validates the envelope, consumes the nonce, persists the result, and updates the linked operation run.
8. Read the verification verdict. If `verified`, the audit row is complete. If `rejected` or `failed`, the page shows the `verification_errors` so you can debug and recreate the request.

## What Claude Code may do inside the prompt

- Read files in the working tree.
- Run shell commands declared in the task prompt.
- Read git state.
- Read Supabase schema **only** if the prompt explicitly lists `supabase_mcp` and the operator's Claude Code session has Supabase MCP configured.
- Return structured findings.

## What Claude Code may not do

- Push commits, open PRs, or merge without a fresh, explicitly-approved bridge request.
- Run `apply_migration` or any production-impacting Supabase MCP tool.
- Log into platforms, read cookies, or touch the OAuth tables directly.
- Return tokens, passwords, or any value matching the forbidden-fields list.

## Tips

- If Claude Code returns prose around the JSON, Signal will reject with `invalid_json`. Tell it explicitly: *"return only the JSON, no fences."*
- Nonces expire 24 hours after creation. If you copy a prompt on Monday and submit on Wednesday, recreate the request.
- Claude Code is allowed to *recommend* a next action; Signal never applies it automatically.

## See also

- [./codex-operator-flow.md](./codex-operator-flow.md)
- [./signed-result-contract.md](./signed-result-contract.md)
- [./result-validation.md](./result-validation.md)
