# LinkedIn OAuth

## Endpoints

- Authorize: `https://www.linkedin.com/oauth/v2/authorization`
- Token: `https://www.linkedin.com/oauth/v2/accessToken`
- Profile (OIDC userinfo): `https://api.linkedin.com/v2/userinfo`

LinkedIn does not currently expose a public token-revocation endpoint that we rely on; disconnect is local-state-only (clear the encrypted tokens and mark `revoked`).

## Flow

OAuth 2.0 + OIDC with PKCE. We request the OpenID + profile scopes for the read-side identity.

## Scopes requested in Phase E3

| Scope | Required | Purpose |
| --- | --- | --- |
| `openid` | yes | OAuth 2.0 + OIDC handshake. |
| `profile` | yes | Identify which LinkedIn account is connected. |

Publishing scopes (`w_member_social`, `w_organization_social`, …) are **not** requested. The publishing phase will add them under a separate approval gate, and `w_organization_social` requires a separately approved LinkedIn Marketing Developer Platform tier.

## Env

```
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
LINKEDIN_REDIRECT_URI=https://your-domain.example/api/oauth/linkedin/callback
```

## Notes

- LinkedIn requires the redirect URI to match the one configured in the developer app *exactly*, including trailing slashes.
- Tokens are returned with a configurable expiry (typically 60 days). Refresh requires a separately approved "Refresh Token Flow" entitlement on most app tiers.
- Company-page publishing needs an additional `r_organization_admin` grant; modeled as `future_company_page_support` in `PLATFORM_OAUTH_CAPABILITIES`.

## See also

- [./platform-oauth-connections.md](./platform-oauth-connections.md)
- [./token-storage-policy.md](./token-storage-policy.md)
