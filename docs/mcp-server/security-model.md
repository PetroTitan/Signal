# Signal MCP server — security model

The Signal MCP HTTP bridge serves external operators. The security model is encoded in four layers:

## Layer 1 — Bearer token discipline

- Token format: `sigt_<43 base64url chars>`, 32 random bytes from `webcrypto.getRandomValues`.
- Only the SHA-256 hash is stored (`mcp_operator_tokens.token_hash`).
- Plaintext is shown to the operator **exactly once**, in the create response.
- The DB column is unique-indexed for O(1) lookup; the bridge looks up by hash, not by id.
- `last_used_at` updates on every accepted call; revocation flips the row to `status='revoked'`.
- Revoked / expired tokens are rejected at the dispatcher; the audit row records `unauthorized`.

## Layer 2 — Workspace scoping

- Each token carries a `workspace_id`. Every tool query filters by that workspace.
- Tools never accept a `workspace_id` argument from the caller — it comes from the token.
- The repository layer always projects encrypted-token / secret columns away before returning.

## Layer 3 — Scope enforcement

- Tools declare `required_scopes` (see [./tool-permissions.md](./tool-permissions.md)).
- The dispatcher checks `hasAllScopes(token.scopes, tool.required_scopes)` before invoking the handler.
- Missing scopes → response `status="unauthorized"` with `error_code="scope_insufficient"`.
- The operator-token UI refuses to mint tokens containing any blocked scope (`publishing:live`, `social_accounts:create`, `secrets:read`, `database:unrestricted`, `billing:write`).

## Layer 4 — Tool surface narrowness

The MCP server exposes **only** the tools listed in `src/mcp/tool-registry.ts`. There is no generic SQL runner, no arbitrary RPC, no schema discovery beyond the documented `GET /api/mcp` endpoint.

Eleven names are explicitly blocked and short-circuit the dispatcher:

```
signal.publish.live · signal.comment.live · signal.social.create_account ·
signal.social.login · signal.cookies.import · signal.sessions.import ·
signal.tokens.read · signal.database.raw_sql · signal.billing.modify ·
signal.pr.merge · signal.production.deploy
```

These are recorded in the audit table with `status='blocked'` so misuse is visible.

## What the server never does

- Returns a token, cookie, session, OAuth secret, encrypted column, or any value matching a secret field name.
- Bypasses the weekly contract (live execution / live publishing has no MCP path).
- Auto-confirms pending records.
- Sends the service-role key anywhere outside the server-only MCP route.
- Logs the bearer token (only the 8-char preview ever renders).

## Service-role usage

The `/api/mcp` route uses `createSupabaseServiceRoleClient` because the caller authenticates with a bearer token, not a Supabase cookie session. The client is **strictly** server-only:

- Imported from `src/lib/supabase/service-role.ts` only inside `src/mcp/` and `src/repositories/mcp-server/`.
- Not re-exported by `src/lib/supabase/index.ts`.
- Returns `null` when `SUPABASE_SERVICE_ROLE_KEY` is unset; the route then returns 503.

A future phase can swap this for per-token SECURITY DEFINER RPCs and drop the service-role dependency entirely. The dispatcher contract stays the same.

## Audit

Every tool call writes one row to `mcp_tool_calls`:

- `tool_name`, `risk_level`, `approval_mode`
- `status`: `allowed | completed | failed | blocked | unauthorized`
- `input_summary` (field names only, never raw values for prepare tools)
- `output_summary` (truncated)
- `error_summary` (when present)

The table has no UPDATE / DELETE policy — workspace members read; inserts come from the dispatcher via the service-role client; closing updates also go through the service-role client (the elevated role bypasses RLS).

## See also

- [./signal-mcp-server.md](./signal-mcp-server.md)
- [./tool-permissions.md](./tool-permissions.md)
- [./operator-token-setup.md](./operator-token-setup.md)
