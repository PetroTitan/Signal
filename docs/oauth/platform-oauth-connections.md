# Platform OAuth connections

Signal connects to social platforms (Reddit, X, LinkedIn) only through their official OAuth flows. Phase E3 ships the model, routes, and UI — it does **not** publish posts, comments, or engagement signals.

## What this phase ships

- A `platform_connections` table that holds the *identity* of every OAuth connection (which account on which platform, what scopes were granted, when it last verified) plus placeholders for encrypted tokens. Workspace-scoped, RLS-protected.
- An `oauth_state_tokens` table for one-shot CSRF state binding (user + workspace + platform + state).
- A pure `src/core/platform-oauth/` module: provider configs, scopes, capabilities, state generation, PKCE helpers, token lifecycle, connection-health evaluation.
- Four API routes per platform: `start`, `callback`, `disconnect`, `health`.
- UI on `/accounts` (Connect / Disconnect / Check connection per account) and `/platforms/*` (read-only OAuth contract panel).

## What this phase does NOT ship

- No publishing. No comments. No engagement.
- No automatic token refresh.
- No background jobs or health probes.
- No real token storage when `TOKEN_ENCRYPTION_KEY` is unset.

## Core rule

> Signal must NEVER ask for passwords, cookies, session tokens, 2FA codes, recovery codes, browser profiles, or fingerprints.

This is enforced by the absence of any code path that asks for these values — the OAuth surface is the only way to connect an account. See [./token-storage-policy.md](./token-storage-policy.md).

## Status vocabulary

```
not_connected | connected | expired | revoked | error | disabled | reauthorization_required
```

Health vocabulary:

```
healthy | degraded | expired | revoked | unknown
```

## Provider list

| Platform | Provider | Status |
| -------- | -------- | ------ |
| Reddit   | Modeled, env-gated | See [./reddit-oauth.md](./reddit-oauth.md) |
| X        | Modeled, env-gated | See [./x-oauth.md](./x-oauth.md) |
| LinkedIn | Modeled, env-gated | See [./linkedin-oauth.md](./linkedin-oauth.md) |

Google Search Console remains a discoverability-only surface and is **not** modeled by this OAuth layer.

## See also

- [./reddit-oauth.md](./reddit-oauth.md)
- [./x-oauth.md](./x-oauth.md)
- [./linkedin-oauth.md](./linkedin-oauth.md)
- [./token-storage-policy.md](./token-storage-policy.md)
- [./connection-health.md](./connection-health.md)
- [./oauth-env-setup.md](./oauth-env-setup.md)
