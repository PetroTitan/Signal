# Reddit Connection Troubleshooting (Phase F2)

Each failure mode below ends with `connection_status` and the
operator-facing UX. Pair this with [reddit-live-connection.md](./reddit-live-connection.md)
for the happy path.

## Symptom-to-cause

### "OAuth app not configured yet."

Cause: one of `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` /
`REDDIT_REDIRECT_URI` is unset.

Fix: set all three in the server env. The redirect URI must match
exactly the value registered in Reddit's app config — including the
scheme and trailing slash.

### "Token encryption not configured."

Cause: `TOKEN_ENCRYPTION_KEY` is unset.

Fix: generate a key (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`)
and set it. See [token-encryption-key.md](./token-encryption-key.md).

### "TOKEN_ENCRYPTION_KEY is set but does not decode to exactly 32 bytes."

Cause: the env value is malformed or the wrong length.

Fix: regenerate with the command above and replace the env value.
The cipher refuses every operation until a valid key is loaded.

### After clicking "Connect", redirected to `/accounts?oauth=not_configured`

The cipher gate refused at the start of the callback. The OAuth
round-trip happened but Signal didn't ask Reddit for a token. No
plaintext was held. Set the encryption key and retry.

### After clicking "Connect", redirected to `/accounts?oauth=exchange_failed`

Reddit returned a 4xx/5xx from `/api/v1/access_token`. The reason
code is in `platform_connections.metadata.token_exchange_code`.
Common causes:

- `provider_4xx` — most often a `REDIRECT_URI` mismatch. The
  Reddit app config and `REDDIT_REDIRECT_URI` env must match
  character-for-character.
- `provider_5xx` — Reddit-side issue. Retry.
- `rate_limited` — too many auth attempts. Wait 5 minutes.
- `network_error` — outbound network from Vercel to
  `www.reddit.com` failed.

### After clicking "Connect", redirected to `/accounts?oauth=encryption_refused`

Token exchange succeeded but `encryptTokenResponse` refused. This
should be impossible if the diagnostic says `configured` — file a
bug. The cipher's `encrypt()` returned null. The plaintext token is
already discarded; no tokens were stored.

### After clicking "Connect", redirected to `/accounts?oauth=profile_failed`

Token exchange + encryption succeeded but `/api/v1/me` failed.
Encrypted tokens are stored but `connection_status='error'`. Try
"Check connection" — the health endpoint will retry the profile
fetch.

### Health: `expired`

The stored access token failed `/me` with 401. If a refresh token is
present, Signal already tried to refresh and that also failed.
Reauthorize the connection.

### Health: `degraded`

Transient failure on the most recent `/me` (Reddit 5xx, 429, or
network). `connection_status` is unchanged. Try again in a few
minutes.

### Health: `revoked` after operator disconnected

Expected. Run the OAuth flow again to reconnect — the encrypted
columns are cleared on disconnect, so the connection starts fresh.

### Connection shows `connected` but publisher refuses

Phase F2 only ships the connection. The publisher gate enforces
additional conditions before live posting:

- `workspace_settings.execution_mode='live'` (see the
  [F1 follow-up blocker](../publishing/publishing-safety.md) for
  the missing column)
- active weekly contract scoping the account
- `submit` scope (deferred to F3 — not requested in F2)
- decryptable token (`decryptForOutboundUse` returns non-null)

If everything else is in order and the publisher still refuses,
check `execution_logs` — the `reason_code` column has the exact gate
that failed.

## Decoding reason codes

The OAuth layer uses these reason codes (in
`platform_connections.metadata.token_exchange_code` and in MCP
responses):

| Code | Meaning |
|---|---|
| `oauth_expired` | Reddit returned 401 |
| `oauth_insufficient_scope` | Reddit returned 403 |
| `rate_limited` | Reddit returned 429 |
| `provider_4xx` | Other 4xx (most often a redirect-uri mismatch) |
| `provider_5xx` | Reddit-side outage |
| `network_error` | fetch threw — DNS or transport issue |
| `decode_error` | Reddit responded but the body was malformed |
| `token_storage_unavailable` | Cipher returned null |

## Quick checks

```sql
-- All Reddit connections in the workspace
SELECT id, account_id, connection_status, health_status,
       (access_token_encrypted IS NOT NULL) AS has_token,
       expires_at, last_checked_at,
       metadata->>'last_message' AS last_message
FROM platform_connections
WHERE workspace_id = '<your-workspace-id>'
  AND platform = 'reddit'
ORDER BY updated_at DESC;
```

```sql
-- Verify every stored token is in the v1 envelope.
-- A non-zero result is a security finding.
SELECT count(*) FROM platform_connections
WHERE access_token_encrypted IS NOT NULL
  AND access_token_encrypted NOT LIKE 'v1:%';
```

## What never appears in any failure path

- The token plaintext.
- `TOKEN_ENCRYPTION_KEY`.
- `REDDIT_CLIENT_SECRET`.

If any of these ever shows up in a log line, an activity row, or a
client response — that's a P0 bug.
