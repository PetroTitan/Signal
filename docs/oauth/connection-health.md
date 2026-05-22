# Connection health

Connection health is a derived view of a `platform_connections` row. Phase E3 evaluates health from local state only — no provider probe — and the operator must click **Check connection** to trigger an evaluation.

## States

```
healthy   — connection_status='connected', token present, not expired
degraded  — connection_status='error' or token missing despite connected status
expired   — connection_status='expired' or expires_at in the past
revoked   — connection_status='revoked'
unknown   — connection_status='not_connected' or 'disabled'
```

## Evaluation logic

`evaluateConnectionHealth(conn: PlatformConnection)` in `src/core/platform-oauth/connection-health.ts`:

1. If `connection_status='revoked'` → `revoked`.
2. If `connection_status='disabled'` → `unknown`.
3. If `connection_status='not_connected'` → `unknown`.
4. If `expires_at < now` → `expired` (and the connection_status flips to `expired`).
5. If `hasAccessToken === false` but status is something else → `degraded` + `reauthorization_required`.
6. If `connection_status` is `error` or `reauthorization_required` → `degraded`.
7. Otherwise → `healthy`.

The function is pure. The repository performs the write.

## When real provider probes arrive

Add a second pass that calls the provider's `profileUrl` (already declared in `OAUTH_PROVIDERS`) with the decrypted access token, and downgrades the verdict if the response is 401/403. Today that branch is intentionally absent — there is no decryption code path because there is no encryption code path.

## See also

- [./platform-oauth-connections.md](./platform-oauth-connections.md)
- [./token-storage-policy.md](./token-storage-policy.md)
