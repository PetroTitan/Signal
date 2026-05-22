# OAuth token storage plan

This document plans how Signal will store platform credentials when OAuth integrations ship in Phase F. **No implementation today**. The plan exists so the eventual integration lands without surprises.

## Non-negotiables

Signal never stores, requests, or transmits:

- platform passwords,
- cookies or browser session tokens (including `connect.sid`-style values, `__Secure-` Google cookies, `cookie_session_id`, etc.),
- raw 2FA codes or recovery codes,
- proxy configurations,
- anti-detect or browser-fingerprint profiles.

There is no column for any of these. The schema is shaped so storing them is structurally impossible without a new table.

## What Signal will store

For every connected platform account, exactly one row in `platform_connections`:

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `workspace_id` | uuid | denormalized for RLS |
| `account_id` | uuid | FK `growth_accounts.id` |
| `provider` | text | `'reddit'`, `'x'`, `'linkedin'`, eventually `'google_search_console'`, `'youtube'` |
| `provider_account_id` | text | the platform's stable account identifier |
| `provider_handle` | text | denormalized for display |
| `scopes` | jsonb | array of granted OAuth scopes |
| `encrypted_access_token` | bytea | sealed with the server key |
| `encrypted_refresh_token` | bytea | sealed with the server key |
| `access_token_expires_at` | timestamptz | derived from the OAuth response |
| `refresh_token_expires_at` | timestamptz | nullable per provider |
| `status` | connection_status | enum: `not_connected`, `pending`, `connected`, `expired`, `revoked`, `error` |
| `connected_at` | timestamptz | first successful authorization |
| `last_refreshed_at` | timestamptz | most recent refresh |
| `revoked_at` | timestamptz | when the founder revoked |
| `last_error` | text | last refresh / use error if any |
| `created_at` | timestamptz | default `now()` |
| `updated_at` | timestamptz | maintained by trigger |

Unique: `(account_id, provider)`.

## How tokens are encrypted

Two acceptable approaches; the choice is made at migration time:

1. **Supabase Vault** — store token material in `vault.secrets`, reference by id from `platform_connections`. Plain `text` columns hold the secret name, never the value.
2. **Server-managed envelope encryption** — Postgres `pgcrypto`'s `pgp_sym_encrypt` with a key held by the server, columns typed as `bytea`. The key never leaves the server environment.

Whichever path is chosen:

- The encrypted column is never returned to the client.
- Decryption happens only inside `security definer` functions that the OAuth refresh and publish paths call.
- All decryption events emit an `audit_logs` row.

## Access patterns

There are only three operations against this table from client surfaces:

1. **Read connection state** — returns row minus the encrypted columns; rendered as the OAuth card status across the app.
2. **Start a connection** — server function initiates the OAuth dance; on success inserts the row.
3. **Revoke a connection** — server function sets `status = 'revoked'`, clears the encrypted columns, writes an `audit_logs` row.

No client surface ever decrypts a token, refreshes a token, or reads token bytes. Every refresh / publish path runs server-side.

## Token lifecycle

```
not_connected → pending → connected → expired → connected (after refresh)
                                              ↘ error (transient)
                                              ↘ revoked (terminal)
```

- `pending` covers the OAuth redirect window.
- `expired` is transient; the next server-side refresh attempts to renew.
- `error` indicates a non-recoverable refresh failure; the connection is shown as broken in the UI and surfaces a clear "reconnect" CTA.
- `revoked` is terminal and irreversible without re-auth.

## Refresh handling

- Scheduled refresh job runs server-side per provider. Frequency derived from `access_token_expires_at`.
- A refresh failure marks `status = 'error'`, populates `last_error`, and writes an `audit_logs` row.
- Three consecutive failures escalate to `expired`; the next request from the UI triggers a re-auth flow.

## Scope hygiene

- Scopes requested per provider are the minimum needed to publish, read engagement, and verify the account identity.
- Scope strings are stored verbatim from the OAuth provider so they remain comparable across refreshes.
- A change to the required scope set forces re-auth (the platform's choice, not ours).

## Audit + observability

Every meaningful token event is logged to `audit_logs`:

- `platform_connection.connected`
- `platform_connection.refreshed`
- `platform_connection.failed_refresh`
- `platform_connection.revoked`
- `platform_connection.deleted`

`occurred_at`, `actor_user_id`, `entity_type='platform_connection'`, `entity_id=platform_connections.id`, and a small JSONB `metadata` payload (provider, scopes hash, last 4 chars of error if present).

## What this layer never does

- **Never** stores plaintext tokens.
- **Never** returns tokens through any public endpoint.
- **Never** exposes the encrypted columns through Supabase queries.
- **Never** persists a token without a corresponding `audit_logs` event.
- **Never** ships a "preview token" mode for debugging in production.

## Future providers

The same shape extends to:

- Google Search Console — read-only scope; produces visibility data, never publishes.
- YouTube — read scope first; uploads behind a separate explicit opt-in.
- WebmasterID API — separate row in `webmasterid_connections` (the encrypted API key is the only credential).
- LinkedIn company pages, Reddit subreddit mod actions, X analytics — same shape; one row per `(account_id, provider)`.

## Migration sequencing

1. Phase F-1: add `platform_connections` table and the `connection_status` enum.
2. Phase F-2: add the OAuth callback server route and the connect/revoke server functions.
3. Phase F-3: wire the existing OAuthFutureCard surfaces to start using the live status.
4. Phase F-4: add per-provider publish paths behind feature flags.

Each step is a separate PR with a separate RLS regression test.

Until Phase F lands, the OAuth card across the app keeps saying "not yet enabled" — honestly, and structurally.
