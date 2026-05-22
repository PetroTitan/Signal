# Codex operator flow

Codex follows the same bridge contract as Claude Code. The differences are practical, not architectural — Codex is stronger at fast patches, less strong at long reasoning audits. Pick the assistant that matches the request type.

## Step-by-step

1. Open `/operator-bridge` and create a request with `assistant_type=codex`.
2. Copy the task prompt.
3. Paste into Codex (CLI or editor integration).
4. Codex returns the JSON envelope.
5. Paste it back into Signal's **Submit result** textarea.
6. Signal verifies and stores the result.

## Recommended request types for Codex

- `repo_patch` (when wired) — small focused diffs.
- `code_review` — reviewing a recent change.
- `test_plan` — proposing tests for a feature.
- `pr_summary` — drafting a PR title and body.

For deeper architectural audits, prefer `claude_opus` instead — see [./claude-code-operator-flow.md](./claude-code-operator-flow.md) for the read-only flavor.

## What Codex may do

- Read the repo.
- Run the commands listed in the prompt.
- Produce a structured result.

## What Codex may not do

- Open PRs or push commits without a fresh, explicitly-approved bridge request.
- Touch production data.
- Return any field whose name is on the forbidden-fields list — the bridge will reject the submission and surface the offending paths.

## See also

- [./claude-code-operator-flow.md](./claude-code-operator-flow.md)
- [./signed-result-contract.md](./signed-result-contract.md)
