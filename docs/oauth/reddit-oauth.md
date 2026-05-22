# Reddit OAuth

## Endpoints

- Authorize: `https://www.reddit.com/api/v1/authorize`
- Token: `https://www.reddit.com/api/v1/access_token`
- Revoke: `https://www.reddit.com/api/v1/revoke_token`
- Profile: `https://oauth.reddit.com/api/v1/me`

## Flow

Standard OAuth 2.0 authorization code grant. Reddit does **not** require PKCE for confidential clients. We request `duration=permanent` so we receive a refresh token.

## Scopes requested in Phase E3

| Scope | Required | Purpose |
| --- | --- | --- |
| `identity` | yes | Confirm which Reddit account is connected. |
| `read` | optional | Read subreddit metadata and the account's own activity for cadence checks. |

Publishing scopes (`submit`, `modposts`, …) are **not** requested in this phase. They will be added under a separate approval gate in the publishing phase.

## Env

```
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_REDIRECT_URI=https://your-domain.example/api/oauth/reddit/callback
```

## Notes

- Reddit's User-Agent rule is mandatory. When the publishing phase wires real token-exchange and profile fetches, include a unique UA in every request.
- Reddit's token responses include `scope` as a comma-separated string; the response parser must split on `,` (not space).
- The revoke endpoint expects `token` and `token_type_hint=access_token` (or `refresh_token`) as form-encoded body params.

## See also

- [./platform-oauth-connections.md](./platform-oauth-connections.md)
- [./token-storage-policy.md](./token-storage-policy.md)
