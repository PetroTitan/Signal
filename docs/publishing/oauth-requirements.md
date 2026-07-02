# OAuth Requirements (Phase F1)

Signal does **not** publish without a real OAuth access token, full
stop. Phase F1 builds the publisher and the safety gates; the cipher
that decrypts tokens at publish time is wired separately (Phase E3
follow-up). Until that wiring lands, every connection sits at
`access_token_encrypted = NULL` and the publishing gate refuses with
reason `no_token`.

## Connection lifecycle

```
platform_connections.status:

  pending
    ↓  operator clicks "Connect" at /accounts/[id]
  oauth_in_progress
    ↓  provider redirect back to /api/oauth/callback
  connected   ←  access_token_encrypted IS NOT NULL
    ↓  401 from provider at publish time
  expired     →  scheduler marks affected items 'blocked' with reason 'oauth_expired'
    ↓  operator re-runs OAuth
  connected
```

`error` is a terminal state for connections that failed during the
OAuth flow itself (operator must inspect and retry).

## What "connected" means in practice

A row in `platform_connections` qualifies for publish only if:

1. `status = 'connected'` — the OAuth callback succeeded.
2. `access_token_encrypted IS NOT NULL` — the cipher actually
   encrypted and stored the secret. **This is the gate that's not
   yet live in production.**
3. `expires_at IS NULL OR expires_at > now()` — token still valid by
   our records. Note: providers can revoke tokens any time, so a
   401/403 at publish time still flips the connection to `expired`.

The scheduler does *not* decrypt the token; it passes
`access_token_encrypted` to the publisher, which decrypts at the
last possible moment using `TOKEN_ENCRYPTION_KEY`. In F1 the
publisher receives `accessToken: null` because the cipher isn't
wired — meaning the policy gate always trips at `no_token` and no
real POST goes out. This is intentional and safe.

## Required env vars for live publishing

| Var | Purpose |
|-----|---------|
| `REDDIT_CLIENT_ID` | OAuth app id |
| `REDDIT_CLIENT_SECRET` | OAuth app secret |
| `REDDIT_REDIRECT_URI` | Must match the value registered on Reddit (e.g. `https://signal.webmasterid.com/api/oauth/callback/reddit`) |
| `TOKEN_ENCRYPTION_KEY` | 32-byte base64-encoded key for AES-GCM at-rest cipher |
| `CRON_SECRET` | Secret Vercel Cron sends as `Authorization: Bearer …` to the cron routes (`/api/scheduler/tick`, `/api/notifications/digest`, `/api/metrics/refresh`). **Required for scheduled runs on Vercel.** |
| `SCHEDULER_TICK_TOKEN` | Optional legacy/manual shared secret accepted by the same cron routes (for curl triggering). Safe to leave unset if only Vercel Cron drives the routes. |

If any of these is unset, the corresponding surface degrades
honestly:

- Missing `REDDIT_*` → `/accounts/[id]` shows "OAuth app not configured."
- Missing `TOKEN_ENCRYPTION_KEY` → `/accounts/[id]` shows "Token
  storage not configured." and OAuth callbacks refuse to store
  plaintext.
- Missing **both** `CRON_SECRET` and `SCHEDULER_TICK_TOKEN` → the cron
  routes return `503` (honestly disabled). Note Vercel Cron only sends
  `CRON_SECRET`; if you set only `SCHEDULER_TICK_TOKEN`, scheduled cron
  invocations will `401` and silently never run.

## Reddit-specific scope

The OAuth scope requested for Reddit is `submit identity` — just
enough to call `/api/submit` and verify the username for User-Agent
formatting. Signal does **not** request `modposts`, `vote`, `read`,
`privatemessages`, or any other scope. Adding scopes is a deliberate
decision documented separately.
