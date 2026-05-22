# Long-lived platform connections

Signal is designed so a user configures a product, configures their workspace, and connects an account through official OAuth — once — and the system stays useful for years.

This document captures the architecture that makes that real: connection statuses, self-healing rules, the degradation model, and what the user is expected to do (and not do) over time.

## The one-time setup principle

The intended user experience:

1. Create a product profile once.
2. Configure workspace / product memory once.
3. Connect each account through official OAuth once.
4. Review the generated weekly plans.
5. Reauthorize only when the platform or its API actually requires it.

The user should **not** have to:

- Re-enter product context.
- Reconfigure tone.
- Reconnect accounts that are still authorized.
- Rebuild weekly workflows.
- Recreate memory profiles.
- Manually fix stale settings.

The schema and the connection model are both built to honor this.

## Connection statuses

Defined in `src/core/platform-connections/connection-status.ts`:

| Status | Meaning |
| --- | --- |
| `not_connected` | No connection exists. |
| `ready_to_connect` | Account is set up on the platform; OAuth not yet started. |
| `pending_authorization` | OAuth flow started but not completed. |
| `connected` | Connection established. |
| `healthy` | Connection established and recently synced successfully. |
| `degraded` | Connection reachable but partial — Signal drops to draft-only. |
| `expired` | Token expired. Drafts preserved. |
| `revoked` | User revoked from the platform side. Drafts preserved. |
| `reauthorization_required` | Platform demands user reauthorization. Drafts preserved. |
| `disabled` | User disabled the connection in settings. |
| `error` | Unexpected error. Drafts preserved. |

Three helpers classify them:

- `isHealthy(status)` — `connected` or `healthy`.
- `needsUserAction(status)` — `expired`, `revoked`, `reauthorization_required`, `error`.
- `publishingAllowed(status)` — true only for healthy/connected states.

## Connection health record

`ConnectionHealthRecord` lives on every connection:

| Field | Purpose |
| --- | --- |
| `last_successful_sync_at` | Timestamp of the last clean sync. |
| `last_failed_sync_at` | Most recent failure. |
| `failed_sync_count` | Consecutive failure counter; resets on success. |
| `refresh_expires_at` | Refresh-token expiration. |
| `recovery_action` | A single user-facing instruction (or null). |
| `degradation_mode` | none \| draft_only \| read_only \| paused. |

The record carries its own `schema_version` so it can evolve independently of the parent connection.

## Derivation rules

`deriveConnectionState(status, health, now)` (`src/core/platform-connections/connection-health.ts`) returns the live `{ status, degradationMode, recoveryAction }` triple based on:

- Explicit lifecycle states (`revoked` / `expired` / `reauthorization_required` / `disabled`) take precedence.
- Three consecutive failed syncs drop the connection to `draft_only` mode.
- Token within 72 hours of expiry → degraded + reauthorization hint.
- Otherwise: no degradation, no recovery action.

Self-healing rules (`SELF_HEALING_RULES`):

1. Refresh tokens are attempted before each sync.
2. Three failed syncs in a row enter degraded mode.
3. Degraded mode preserves drafts and schedules; publishing is paused.
4. User reauthorization is the only manual recovery action ever surfaced.
5. Signal never retries aggressively; backoff is bounded.

## Failure handling

If a platform connection fails, Signal:

1. Pauses publishing for that account (degradation mode = `draft_only`).
2. Preserves drafts and schedules. Nothing is lost.
3. Shows one clear recovery action.
4. Never silently loses data.
5. Never retries aggressively.

## Schema evolution

The connection itself carries `PLATFORM_CONNECTION_SCHEMA_VERSION`. Health records carry `CONNECTION_HEALTH_SCHEMA_VERSION`. Memory entities carry their own `schemaVersion`. Across all of them:

- New fields are added as optional first.
- Renames take two migrations: add, then remove.
- Deprecated fields stay readable until callers move off them.
- Approved drafts and approval events are preserved across schema changes.

## What stays out of long-lived connections

Even with long-lived tokens, Signal will never store:

- Passwords.
- Cookies.
- Browser sessions.
- 2FA codes.
- Recovery codes.
- Proxy fingerprints or anti-detect profiles.

Only official OAuth tokens are stored, encrypted and server-side, when integrations ship.

## What the UI promises

The settings UI uses realistic copy:

- "Configure once. Signal reuses your product, platform, and account context."
- "Connections may occasionally require reauthorization if a platform changes permissions."
- "Signal falls back to draft-only mode instead of breaking the workflow."

It does **not** promise:

- works forever
- never reconnect
- guaranteed publishing
- no bugs

Trust comes from being honest about the failure modes, not from promising they cannot happen.

## See also

- [./account-authentication-readiness.md](./account-authentication-readiness.md)
- [./platform-capability-matrix.md](./platform-capability-matrix.md)
- [./oauth-first-principle.md](./oauth-first-principle.md)
- [../architecture/one-time-setup-principle.md](../architecture/one-time-setup-principle.md)
- [../database/oauth-token-storage-plan.md](../database/oauth-token-storage-plan.md)
