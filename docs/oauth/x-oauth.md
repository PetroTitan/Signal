# X OAuth

## Endpoints

- Authorize: `https://twitter.com/i/oauth2/authorize`
- Token: `https://api.twitter.com/2/oauth2/token`
- Revoke: `https://api.twitter.com/2/oauth2/revoke`
- Profile: `https://api.twitter.com/2/users/me`

## Flow

OAuth 2.0 with **PKCE** (S256). X requires PKCE even for confidential clients. The state plus code-verifier are persisted to `oauth_state_tokens` at `/start` and consumed at `/callback`.

## Scopes requested in Phase E3

| Scope | Required | Purpose |
| --- | --- | --- |
| `users.read` | yes | Confirm which X account is connected. |
| `tweet.read` | optional | Cadence checks against the account's own posts. |
| `offline.access` | yes | Required to receive a refresh token. |

Publishing scopes (`tweet.write`, `tweet.moderate.write`, …) are **not** requested. The publishing phase will add them under a separate approval gate.

## Env

```
X_CLIENT_ID=
X_CLIENT_SECRET=
X_REDIRECT_URI=https://your-domain.example/api/oauth/x/callback
```

## Notes

- API access tiers matter. The Free tier blocks several read endpoints; the OAuth flow itself works on any tier, but the publishing-phase write endpoints require Basic or higher.
- X access tokens expire in 2 hours; refresh tokens are long-lived. The Phase E3 layer records `expires_at`; a future PR adds automatic refresh.
- The revoke endpoint accepts `token` + `token_type_hint`.

## See also

- [./platform-oauth-connections.md](./platform-oauth-connections.md)
- [./token-storage-policy.md](./token-storage-policy.md)
