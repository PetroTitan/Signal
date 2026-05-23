# Reddit Token Lifecycle (Phase F2)

How a Reddit access token moves through Signal from the moment
Reddit issues it to the moment it's revoked.

```
[Reddit] ──code──▶ /api/oauth/reddit/callback
                       │
                       ▼
            exchangeCodeForToken (basic auth)
                       │
       plaintext token (request-scope only) ◀── never logged
                       │
                       ▼
            encryptTokenResponse  (AES-256-GCM, v1 envelope)
                       │
                       ▼
            upsertPlatformConnection
              .access_token_encrypted = "v1:<iv>:<tag>:<ct>"
              .refresh_token_encrypted = "v1:<iv>:<tag>:<ct>"
                       │
                       ▼
              [stored at rest, never read in plaintext]
```

## Storage envelope

```
v1:<iv_b64u>:<tag_b64u>:<ciphertext_b64u>
```

- `v1` — version prefix. Lets us rotate the algorithm later.
- `iv` — 12-byte (96-bit) random IV, per encryption.
- `tag` — 16-byte GCM authentication tag.
- `ciphertext` — UTF-8 token encrypted with AES-256-GCM.

All three components are base64url, no padding. The single string is
stored in `platform_connections.access_token_encrypted`. There is no
key id; the key is whichever value of `TOKEN_ENCRYPTION_KEY` was
loaded at decrypt time. (See [token-encryption-key.md](./token-encryption-key.md)
for rotation.)

## Decrypt — only at the last moment

Two callers decrypt:

1. **Health check** — `/api/oauth/reddit/health` decrypts to call
   `/api/v1/me`, then discards the plaintext.
2. **Publisher** — `publishing-scheduler.ts` decrypts only when
   `execution_mode='live'` AND `accessTokenEncrypted IS NOT NULL`,
   inside the scheduler tick. The plaintext is passed to the policy
   gate and (if it passes) to the Reddit publisher. It never lives
   longer than the publish attempt.

```typescript
// publishing-scheduler.ts
let accessToken: string | null = null;
if (mode === "live" && accessTokenEncrypted) {
  const { decryptForOutboundUse } = await import("@/core/platform-oauth");
  accessToken = decryptForOutboundUse(accessTokenEncrypted);
}
```

`decryptForOutboundUse` returns `null` on any failure (envelope
corrupt, key missing, version mismatch). The caller treats `null`
exactly like "no token stored" — refuse and emit
`oauth_token_not_stored`.

## Refresh

Reddit's `refresh_token` is stored encrypted in
`refresh_token_encrypted`. The health endpoint refreshes on 401:

```
GET /api/v1/me  →  401
   ↓
decryptForOutboundUse(refresh_token_encrypted)
   ↓
refreshAccessToken(runtime, refreshToken) → new {access_token, refresh_token, expires_in}
   ↓
encryptTokenResponse  →  v1 envelope (fresh IV)
   ↓
rotateAccessToken(connection_id, new_envelope, scopes, expires_at)
   ↓
retry GET /api/v1/me
```

If the refresh itself returns 401, the connection is marked
`reauthorization_required` + `health_status='expired'` and the
operator must re-run OAuth. The encrypted envelopes are **not**
cleared on a failed refresh — the operator may want to inspect the
last-known scopes; the columns are cleared only on explicit
disconnect.

## Disconnect

```
POST /api/oauth/reddit/disconnect
   ↓
revokeToken(refresh_token || access_token, type_hint)
   ↓
markConnectionStatus('revoked')
   ↓
   access_token_encrypted = NULL
   refresh_token_encrypted = NULL
   revoked_at = now
   health_status = 'revoked'
   ↓
setAccountConnectionStatus(growth_accounts, 'not_connected')
   ↓
activity_events.platform_connection.disconnected
```

The provider revoke is best-effort. If Reddit's revoke endpoint is
unreachable, Signal still wipes its local copy — that's what
guarantees the token can't be used again from Signal.

## What never gets persisted

- Plaintext tokens (anywhere, including logs).
- Decrypted tokens beyond the lifetime of a single outbound request.
- `TOKEN_ENCRYPTION_KEY`.
- Reddit client secret.

The `oauth_token_security_check` verification check counts any
`access_token_encrypted` values that don't begin with `v1:` and
fails the check if any are found.

## Audit trail

| Activity event | Source |
|---|---|
| `platform_connection.started` | `/api/oauth/reddit/start` |
| `platform_connection.connected` | `/api/oauth/reddit/callback` (success) |
| `platform_connection.failed` | `/api/oauth/reddit/callback` (any of: cipher unavailable, token exchange failed, encryption refused, profile fetch failed) |
| `platform_connection.health_checked` | `/api/oauth/reddit/health` |
| `platform_connection.disconnected` | `/api/oauth/reddit/disconnect` |

Activity rows record the outcome but never the token. The most they
include is the http status, the reason code, and the username if the
token worked.
