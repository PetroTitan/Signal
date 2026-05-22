# Token storage policy

OAuth access tokens and refresh tokens are the most sensitive data Signal handles. The policy is binary: **either encryption is configured and tokens are stored encrypted, or no tokens are stored at all.** There is no in-between.

## Where tokens live

`platform_connections.access_token_encrypted` and `platform_connections.refresh_token_encrypted` — `text` columns at the SQL layer, written only by server code, never returned to the client.

The repository layer projects these columns away in `toConnection()` and exposes only `hasAccessToken: boolean` / `hasRefreshToken: boolean` to callers. The client never sees a token value, not even encrypted.

## The cipher gate

```ts
interface TokenCipher {
  encrypt(plaintext: string): string | null;
  decrypt(ciphertext: string): string | null;
  isAvailable(): boolean;
  describe(): string;
}
```

The default cipher (`NOOP_CIPHER`) returns null for everything and reports `isAvailable() === false`. The token-lifecycle helper `composeTokenPersistence` refuses to persist when the cipher is unavailable — it returns `{ ok: false, reason: ... }` and the OAuth callback records the connection with `connection_status='error'` and `metadata.token_storage='not_configured'`.

This is intentional: **"encryption not configured" is a hard error, not a silent downgrade.** A future PR can swap `resolveTokenCipher()` for an AES-GCM cipher backed by `TOKEN_ENCRYPTION_KEY` (KMS-derived, never in app env in production).

## What we never do

- Store plaintext tokens.
- Log token values, even at debug level.
- Include token values in error messages, activity events, or metadata.
- Return token values from API routes — `/api/oauth/*/health` returns the verdict only.
- Allow client code (anything under `"use client"`) to import the repository — the repository is `server-only`.

## What the UI can show

- `hasAccessToken` / `hasRefreshToken` booleans
- `connection_status` and `health_status`
- `expires_at` (a timestamp, not a token)
- `connected_at` / `last_checked_at`

Nothing else.

## RLS layer

Postgres RLS allows workspace members to read `platform_connections` rows. We don't have column-level RLS, so the discipline of not returning token columns to the client lives in the repository. Auditors should treat any new `select` that names `access_token_encrypted` or `refresh_token_encrypted` outside the repository as a regression.

## See also

- [./platform-oauth-connections.md](./platform-oauth-connections.md)
- [./oauth-env-setup.md](./oauth-env-setup.md)
