# Operator bridge security model

The bridge is a *control* surface. The security model is encoded in `src/core/operator-bridge/bridge-policy.ts` and enforced at four layers.

## Layer 1 — RLS

Every bridge table is workspace-scoped:

- `operator_bridge_requests` — read / insert / update only when the user is a member; no delete.
- `operator_bridge_results` — same; no delete.
- `operator_bridge_nonces` — same; no delete.

No service-role key is ever used. There is no code path that imports it.

## Layer 2 — Server-action gating

Every server action calls `getPrimaryWorkspace()` first. The action then loads the request from the DB and trusts the DB values, not the form. A client cannot specify `assistant_type` or `risk_level` on submission — those are read off the request row.

## Layer 3 — Schema validator

`parseResultEnvelope` rejects any submission that:

- isn't valid JSON
- doesn't match the envelope shape
- exceeds size limits (256 KB payload, 4000-char summary)
- contains a forbidden field anywhere in the JSON tree

The forbidden-fields list:

```
password, passwords, cookie, cookies, session_token, session_tokens,
session_id, access_token, access_tokens, refresh_token, refresh_tokens,
bearer_token, service_role, service_role_key, private_key, private_keys,
recovery_code, recovery_codes, secret, secrets, client_secret, api_key
```

Match is case-insensitive, substring-based. `oauth_session_token`, `OAUTH_BEARER_TOKEN`, and `userServiceRole` all trigger.

## Layer 4 — Nonce + verification verdict

Each request mints one fresh nonce. The verifier requires the nonce to be active, workspace-scoped to the request, and not expired. Consume is atomic — a second submission with the same nonce hits `nonce_used` and the result is rejected.

The request must not be in a terminal state when the result arrives. If it is, the verifier returns `request_<status>` (e.g. `request_cancelled`) and refuses.

## What the bridge never does

- Auto-applies `recommended_next_action`.
- Trusts the `assistant_type` field on submission — it must match the request.
- Stores the operator's source text from the import flow inside the bridge result.
- Logs nonce values (only first 12 characters are rendered in the UI).
- Reuses a consumed nonce, even after rollbacks.
- Bypasses the linked `mcp_operation_runs` row — every bridge request opens one, and every verified result closes one.

## Future hardening

- HMAC signing (already scaffolded in `bridge-signature.ts`).
- Per-assistant signing keys.
- Per-request short-lived tokens for direct-bridge transport.
- Bytecode-bounded sandboxing of the result payload before persistence.

## See also

- [./signed-result-contract.md](./signed-result-contract.md)
- [./result-validation.md](./result-validation.md)
- [./operator-bridge-runtime.md](./operator-bridge-runtime.md)
