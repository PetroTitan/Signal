# Operator bridge runtime

Phase E2.8 introduces the first real bridge between Signal and operator-run AI assistants (Claude Code, Codex, Claude Opus). Signal remains the control plane; the assistants remain operator-side execution agents.

## Loop

```
1. Operator clicks "Create bridge request" in /operator-bridge.
2. Signal stores the request, mints a one-shot nonce, and links a
   pending mcp_operation_runs row.
3. Operator opens the request and copies the task prompt.
4. Operator pastes the prompt into Claude Code / Codex / Opus.
5. Assistant performs only the allowed checks, returns a structured
   JSON envelope including the request_id and nonce.
6. Operator pastes the JSON back into Signal.
7. Signal validates the envelope, consumes the nonce, and stores the
   result. The mcp_operation_runs row closes.
8. The recommended_next_action never executes automatically — the
   operator reviews and applies it manually.
```

Signal is **not** directly controlling Claude. It is orchestrating, validating, and auditing the work.

## What this phase adds

- Three tables: `operator_bridge_requests`, `operator_bridge_results`, `operator_bridge_nonces` (workspace-scoped, RLS).
- `src/core/operator-bridge/` — types, policy, signature helpers, result schema validator, verification verdict, status machine, copyable prompt builder, typed errors, report builder.
- `src/repositories/operator-bridge/` — request CRUD, result append + verification update, one-shot nonce consume, mcp_operation_runs linkage.
- Five server actions: `createOperatorBridgeRequestAction`, `markOperatorRequestCopiedAction`, `submitOperatorBridgeResultAction`, `verifyOperatorBridgeResultAction`, `cancelOperatorBridgeRequestAction`.
- `/operator-bridge` (list + create) and `/operator-bridge/[id]` (copy prompt, submit result, view audit trail).
- Sidebar link under Configure; CTAs from `/settings/mcp` and `/imports`.

## What this phase does NOT add

- No autonomous publishing.
- No browser-automation login flows.
- No production redeploy / merge automation.
- No service-role-key exposure to the client.
- No auto-apply of `recommended_next_action`.

## Approval-gate mapping

| Request risk | Approval mode (operator side) |
| --- | --- |
| `safe_read` | `no_approval_needed` |
| `local_write` | `approval_required` |
| `remote_write` | `approval_required` |
| `production_impacting` | `explicit_text_confirmation_required` |
| `blocked` | UI refuses to create the request |

The bridge request's approval_mode lives on the linked `mcp_operation_runs` row, so existing approval surfaces (`/settings/mcp` pending list) gate it the same way as any other production-impacting operation.

## See also

- [./signed-result-contract.md](./signed-result-contract.md)
- [./claude-code-operator-flow.md](./claude-code-operator-flow.md)
- [./codex-operator-flow.md](./codex-operator-flow.md)
- [./security-model.md](./security-model.md)
- [./result-validation.md](./result-validation.md)
