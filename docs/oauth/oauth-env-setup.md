# OAuth env setup

Every OAuth provider requires three server-side env values plus one shared token-encryption key. Missing any of the three for a provider hides the Connect button on `/accounts` and shows "OAuth app not configured yet." on the corresponding `/platforms/*` page.

## Required env

```bash
# Reddit
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_REDIRECT_URI=

# X
X_CLIENT_ID=
X_CLIENT_SECRET=
X_REDIRECT_URI=

# LinkedIn
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
LINKEDIN_REDIRECT_URI=

# Required for *any* connection to actually store tokens.
# Until this is set, the OAuth callback completes but records the
# connection with status='error' and metadata.token_storage='not_configured'.
TOKEN_ENCRYPTION_KEY=
```

## Server-only

These names do **not** carry the `NEXT_PUBLIC_` prefix. They are secrets. Vercel / hosting env should treat them as such and never bundle them into the client. The `src/lib/oauth/env.ts` reader is gated by `"server-only"` and only ever runs inside route handlers.

## Redirect URIs

Each `*_REDIRECT_URI` must match exactly what the provider has on file. The route is:

```
https://<your-host>/api/oauth/<platform>/callback
```

There is one redirect URI per platform; do not share across providers.

## Provider developer apps

| Platform | Where to create the app |
| --- | --- |
| Reddit | https://www.reddit.com/prefs/apps |
| X | https://developer.twitter.com/en/portal/dashboard |
| LinkedIn | https://www.linkedin.com/developers/apps |

For each app, set the redirect URI to the path above, generate the client secret, and copy values into the env. Phase E3 does not need any publishing entitlement — only the basic read-side scopes documented in each platform's doc.

## Verifying the wiring

After setting the env and redeploying:

1. Visit `/accounts`.
2. Under "OAuth providers" you should see "Configured" next to the platform.
3. If a growth_accounts row exists for that platform, "Connect via OAuth" appears.
4. Until `TOKEN_ENCRYPTION_KEY` is set, the row at "OAuth providers" → "Token encryption" will say "Not configured — real tokens will not be stored."

## See also

- [./token-storage-policy.md](./token-storage-policy.md)
- [./platform-oauth-connections.md](./platform-oauth-connections.md)
