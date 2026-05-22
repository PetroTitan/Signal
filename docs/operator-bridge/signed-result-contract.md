# Signed result contract

The result envelope Claude / Codex / Opus returns is plain JSON. Phase E2.8 uses **nonce-based replay protection** as the minimum viable signature — HMAC signing remains an option for later phases when `OPERATOR_BRIDGE_SECRET` is configured.

## Envelope shape

```json
{
  "request_id": "f4b7…",
  "nonce": "8KZ-mU4…",
  "assistant_type": "claude_code",
  "status": "completed",
  "summary": "Short single-sentence summary.",
  "checks": [
    {
      "name": "example_check",
      "status": "pass",
      "details": ["line 1", "line 2"]
    }
  ],
  "artifacts": [],
  "recommended_next_action": "Open a PR to fix X.",
  "requires_user_approval": true
}
```

Required: `request_id`, `nonce`, `assistant_type`, `status`, `summary`, `checks`, `requires_user_approval`.

Optional: `artifacts`, `recommended_next_action`.

## What Signal verifies

1. **JSON validity.** Strict `JSON.parse`; failures return `invalid_json`.
2. **Top-level shape.** Required fields present with the right types.
3. **`assistant_type`** is one of the six known kinds.
4. **`status`** is `completed` / `failed` / `needs_review`.
5. **`checks[]`** is an array of `{ name, status, details? }` with `status ∈ pass | warning | fail`.
6. **`request_id`** equals the request's id.
7. **`nonce`** exists in `operator_bridge_nonces`, is `active`, has matching `workspace_id` and `request_id`, and `expires_at >= now()`.
8. **`assistant_type`** equals the request's `assistant_type`.
9. **Request not in a terminal state** (verified / completed / cancelled / rejected / expired).
10. **Forbidden-fields scan** walks the whole payload and rejects any key whose name contains `password`, `cookie`, `session_token`, `access_token`, `refresh_token`, `bearer_token`, `service_role`, `private_key`, `recovery_code`, `secret`, `client_secret`, `api_key` (case-insensitive).
11. **Result size** under 256 KB.
12. **Summary length** under 4000 chars.

## What happens on success

- Nonce flips to `status='used'`, `used_at=now()`.
- `operator_bridge_results` row inserted with `status='verified'`, `verification_status='verified'`.
- Request walks `pending_operator / copied / running → result_submitted → verified`.
- Linked `mcp_operation_runs` row closes with `status='completed'` and the summary.
- Activity event `operator_bridge.result_verified` fires.

## What happens on failure

- The result row is still persisted with `status='rejected' | 'failed'` and `verification_errors=[…]` so the operator can see why.
- Request flips to `failed_verification` (recoverable: operator can recreate or retry).
- Linked `mcp_operation_runs` row closes with `status='failed'` and the error list.
- Activity event `operator_bridge.result_failed_verification` fires.

## Nonces

- One-shot. The first successful `consumeNonce` flips `status='used'` and any subsequent attempt is rejected with `nonce_used`.
- Workspace-bound. A nonce minted for workspace A cannot be consumed against workspace B.
- Time-bound. Default TTL 24 hours; controlled by `BRIDGE_NONCE_TTL_MS`.
- Revocable. Cancelling a request leaves the nonce row in place (audit trail) but the verifier refuses it because the request is terminal.

## Optional HMAC layer

`bridge-signature.ts` exports `computeSignature` and `verifySignature` for callers that want to layer HMAC-SHA256 over the nonce check. The contract:

```
canonical = "request_id=…&nonce=…&status=…&summary=…"
signature = base64url(HMAC-SHA256(OPERATOR_BRIDGE_SECRET, canonical))
```

The verifier uses constant-time comparison. Today no code path calls `verifySignature` automatically — it ships ready so a future phase can wire signed results without changing the schema.

## See also

- [./result-validation.md](./result-validation.md)
- [./security-model.md](./security-model.md)
- [./operator-bridge-runtime.md](./operator-bridge-runtime.md)
