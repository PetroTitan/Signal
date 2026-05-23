# TOKEN_ENCRYPTION_KEY (Phase F2)

Signal encrypts every OAuth token at rest with AES-256-GCM. The key
that drives that cipher is `TOKEN_ENCRYPTION_KEY`. Without it,
Signal refuses to store real tokens — every OAuth callback completes
the round-trip but lands as `connection_status='error'` with
`metadata.token_storage='not_configured'`.

## Format

- **Server-only.** Never `NEXT_PUBLIC_`.
- **32 bytes exactly** (AES-256).
- Encoded as **base64url (no padding)** or standard **base64**. Both
  decode to the same 32 bytes; pick whichever your secret manager
  prefers.
- The cipher reads `TOKEN_ENCRYPTION_KEY` once at module load and
  runs a `encrypt+decrypt` self-test against the literal string
  `"__signal_cipher_self_test__"`. If the round-trip fails, the
  cipher reverts to no-op and `getTokenCipherDiagnostic()` reports
  `status='invalid'`.

## Generating a key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Both work:

```
# base64url (preferred, URL- and shell-safe)
fEd7m9Q2gA8XdkRfRYBczgnAm3Yc-A1Y5cTeqkc2VHU

# standard base64
fEd7m9Q2gA8XdkRfRYBczgnAm3Yc+A1Y5cTeqkc2VHU=
```

## Setting the key

Local development (one of):
```bash
# 1. add to .env.local — gitignored
echo "TOKEN_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" >> .env.local

# 2. or set on the command line for a single run
TOKEN_ENCRYPTION_KEY=$(node -e ...) pnpm dev
```

Vercel (production):
1. Project → Settings → Environment Variables.
2. Add `TOKEN_ENCRYPTION_KEY` for **Production** and **Preview**.
3. Redeploy. The cipher self-test runs at module load on the first
   request after deploy.

## Rotation

The envelope is versioned (`v1:<iv>:<tag>:<ciphertext>`). To rotate
keys:

1. Add the new key as `TOKEN_ENCRYPTION_KEY` (the cipher will use it
   going forward).
2. Re-run the OAuth flow for every connected account — the callback
   re-encrypts under the new key.
3. The `oauth_token_security_check` flags any rows whose
   `access_token_encrypted` is not in the v1 envelope, so stragglers
   surface during the next verification run.

We don't ship key-rotation tooling in F2; it's a manual operator
task. Future work: a v2 envelope with a key id prefix and a
background re-encrypt job.

## Refusal modes

| Diagnostic status | Cause | UX |
|---|---|---|
| `missing` | env not set | "Token encryption not configured." Connect button hidden on `/platforms/reddit`; OAuth callback records `connection_status='error'` |
| `invalid` | wrong length, malformed base64, self-test failed | "TOKEN_ENCRYPTION_KEY is set but does not decode to exactly 32 bytes." Same callback behavior |
| `configured` | self-test passed | "Token encryption configured (AES-256-GCM, v1 envelope)." Connect available |

## What never goes through the cipher

- Operator MCP tokens (`sigt_...`) — those are SHA-256 hashed at
  storage, never reversible.
- Supabase auth cookies — managed by Supabase.
- Workspace settings, weekly contracts, plan items — not secrets.
- The key itself — never logged, never returned over the wire,
  never written to error messages.

## Related

- [reddit-live-connection.md](./reddit-live-connection.md) — the
  Reddit-specific connection flow.
- [reddit-token-lifecycle.md](./reddit-token-lifecycle.md) — how
  encrypted tokens move through Signal at runtime.
- [token-storage-policy.md](./token-storage-policy.md) — the
  no-plaintext, no-logging, no-client-bundle rules.
