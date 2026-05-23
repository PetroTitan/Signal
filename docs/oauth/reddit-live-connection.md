# Reddit Live Connection (Phase F2)

> ⚠️ **Phase F2.5 update — Reddit API approval pending.** Reddit's
> Responsible Builder Policy blocks the OAuth round-trip at the
> moment (`invalid_client_id` on `/authorize`). The flow described
> below will work once approval lands; until then, see
> [reddit-api-approval-pending.md](./reddit-api-approval-pending.md)
> for the manual-publish fallback.

Phase F2 ships a real, encrypted Reddit OAuth connection. Phase F2 does
**not** ship live publishing — that's Phase F3. The connection
exists so the operator can verify Signal has the right account
configured and a healthy token before any post goes live.

## Scope requested

| Scope | Why | Phase |
|---|---|---|
| `identity` | Confirm which account is connected; read its handle. | F2 |
| `read` | (deferred) Cadence checks against the account's own activity. | future |
| `submit` | (deferred) Publish text + link posts. | F3 |

F2 only requests `identity`. The Reddit OAuth provider config is
asserted by the [`oauth_token_security_check`](../../src/repositories/verification/safety-checks.ts)
which fails if `submit` ever shows up in the provider config.

## Required env

```
REDDIT_CLIENT_ID=<from Reddit "apps">
REDDIT_CLIENT_SECRET=<from Reddit "apps">
REDDIT_REDIRECT_URI=https://signal.webmasterid.com/api/oauth/reddit/callback
TOKEN_ENCRYPTION_KEY=<32-byte base64url>
```

`REDDIT_REDIRECT_URI` must match exactly the value registered in
Reddit's app config — Reddit fails the exchange on any mismatch.

## Flow

```
1. Operator clicks "Connect via OAuth" on /accounts/[id]
   → GET /api/oauth/reddit/start?account_id=<uuid>&redirect_after=/accounts
2. /start generates a state token, persists it to oauth_state_tokens,
   redirects to https://www.reddit.com/api/v1/authorize with
   duration=permanent so we get a refresh token.
3. Operator approves on Reddit.
4. Reddit redirects back to /api/oauth/reddit/callback?code=...&state=...
5. /callback:
   a. consumeOAuthState (one-shot delete)
   b. Cipher.isAvailable() check — refuse if not
   c. exchangeCodeForToken (Basic auth + form body)
   d. encryptTokenResponse — v1 envelope, IV + tag + ciphertext
   e. fetchMe (Reddit /api/v1/me) — confirms the token works,
      harvests handle + provider_account_id
   f. upsertPlatformConnection(connection_status='connected', healthy)
   g. setAccountConnectionStatus(growth_accounts.connection_status='connected')
   h. activity_events: platform_connection.connected
   i. redirect back to /accounts?oauth=connected
```

Every failure step records `platform_connection.failed` activity and
redirects with a specific `?oauth=...` reason code the UI can
render.

## What's stored

In `platform_connections`:

| Column | Value |
|---|---|
| `access_token_encrypted` | `v1:<iv>:<tag>:<ciphertext>` |
| `refresh_token_encrypted` | same envelope (if Reddit returned one) |
| `expires_at` | now + `expires_in` seconds |
| `scopes` | `["identity"]` |
| `connection_status` | `connected` |
| `health_status` | `healthy` |
| `handle` / `display_name` | from `/api/v1/me` |
| `provider_account_id` | `t2_<id>` from `/api/v1/me` |
| `metadata.token_storage` | `"aes-256-gcm"` |

Nothing else. The plaintext token is held in the request handler's
scope for the round-trip and discarded.

## What never leaves the server

- The access token plaintext (only encrypted envelope leaves the cipher).
- The refresh token plaintext.
- `TOKEN_ENCRYPTION_KEY`.
- Reddit client secret (used for Basic auth, never logged).

## Health check

`POST /api/oauth/reddit/health` with `{account_id}`:

1. Decrypts the access token.
2. Calls `https://oauth.reddit.com/api/v1/me`.
3. On 200 → `health=healthy`, `last_checked_at=now`.
4. On 401 + refresh token present → call `refreshAccessToken`, rotate
   the encrypted envelope, retry `/me` once.
5. On 401 + no refresh → `connection_status='reauthorization_required'`,
   `health_status='expired'`.
6. On 429 / 5xx / network → `health_status='degraded'` (transient).

Every outcome writes an `activity_events.platform_connection.health_checked`
row.

## Disconnect

`POST /api/oauth/reddit/disconnect` with `{account_id}`:

1. Best-effort `revokeToken` against Reddit (prefers the refresh
   token; falls back to the access token).
2. `markConnectionStatus('revoked')` — clears
   `access_token_encrypted` and `refresh_token_encrypted` columns,
   sets `revoked_at=now`, `health_status='revoked'`.
3. `setAccountConnectionStatus('not_connected')` on the
   `growth_accounts` row.
4. `activity_events.platform_connection.disconnected`.

Network failures on the revoke call are non-fatal — the local clear
is what guarantees Signal can't re-use the token.

## Why this is not enough to publish

The Reddit publisher in `src/core/publishing/publish-reddit.ts` is
already token-ready: the runner passes `accessToken` to it. The
[publishing-policy.ts](../../src/core/publishing/publishing-policy.ts)
gate still refuses unless **every** F2 condition is also met:

- `workspace_settings.execution_mode='live'` (still requires the F1
  follow-up to add this column — see [publishing-safety.md](../publishing/publishing-safety.md))
- active weekly contract scoping the account/product/platform
- approved post with a creative
- scheduled_at in the past
- `connection_status='connected'` and `health_status='healthy'`
- decryptable token (`decryptForOutboundUse` returns non-null)
- the `submit` scope (deferred to F3)

F2 ships the **token**. F3 ships the actual `submit` scope and the
controlled test path.

## Troubleshooting

See [reddit-connection-troubleshooting.md](./reddit-connection-troubleshooting.md).
