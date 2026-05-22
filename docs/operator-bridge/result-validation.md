# Result validation

Every submission to the bridge runs through three sequential checks. Each rejection writes a row to `operator_bridge_results` with `verification_status='rejected' | 'failed'` and the list of error codes — so the operator can see exactly what went wrong.

## 1. Envelope schema (`parseResultEnvelope`)

Errors this stage can emit:

| Code | Meaning |
| --- | --- |
| `invalid_json` | The submission did not parse as JSON. |
| `envelope_not_object` | Top-level value is not an object. |
| `result_too_large` | Re-serialized envelope exceeds 256 KB. |
| `missing_request_id` / `missing_nonce` | Required identifier absent or empty. |
| `invalid_assistant_type` | Not one of the six known kinds. |
| `invalid_status` | Not `completed` / `failed` / `needs_review`. |
| `invalid_summary` | Missing, empty, or longer than 4000 chars. |
| `invalid_requires_user_approval` | Not a boolean. |
| `checks_not_array` | `checks` field missing or not an array. |
| `checks[N]_not_object` | A check entry isn't an object. |
| `checks[N]_missing_name` | Check missing `name`. |
| `checks[N]_invalid_status` | Check `status` is not `pass` / `warning` / `fail`. |
| `checks[N]_invalid_details` | `details` isn't a string array. |
| `forbidden_field:<path>` | Some leaf path contains a forbidden token. |
| `result_not_serializable` | JSON re-encoding failed. |

If any of these emit, the request flips to `failed_verification` and the rejection row is persisted.

## 2. Request identity check

After schema parsing, the action loads the request from the DB and checks:

- `envelope.request_id === request.id` → otherwise `request_id_mismatch`.

This is checked *before* the nonce is consumed so a wrong-request submission cannot accidentally burn the nonce.

## 3. Nonce + verification verdict (`verifyEnvelopeAgainstRequest`)

Errors this stage can emit:

| Code | Meaning |
| --- | --- |
| `nonce_not_found` | No row in `operator_bridge_nonces` for the submitted nonce. |
| `nonce_workspace_mismatch` | Nonce exists but for a different workspace. |
| `nonce_request_mismatch` | Nonce exists but for a different request. |
| `nonce_used` / `nonce_expired` / `nonce_revoked` | Nonce already consumed / expired / revoked. |
| `assistant_type_mismatch` | Envelope's `assistant_type` ≠ request's `assistant_type`. |
| `request_cancelled` / `verified` / `completed` / `rejected` / `expired` | Request is in a terminal state. |
| `request_expired` | Request's own `expires_at` has passed. |

When all clear, the verdict is `verified`. Otherwise:

- `rejected` — envelope was structurally valid but failed identity / nonce / request checks.
- `failed` — schema-shape issues only.

## Audit fields

`operator_bridge_results` carries:

- `verification_status`: `pending | verified | rejected | failed`.
- `verification_errors`: text array (always present, empty on success).
- `signature` / `signed_at`: optional HMAC if a future phase wires signing.
- `metadata`: free-form jsonb for the runner's notes.

The activity stream mirrors the verdict via either `operator_bridge.result_verified` or `operator_bridge.result_failed_verification`.

## See also

- [./signed-result-contract.md](./signed-result-contract.md)
- [./security-model.md](./security-model.md)
