# Account authentication readiness

Signal does not yet implement real OAuth flows. This document describes the architecture that's in place so the future integration is calm, predictable, and safe.

## What ships today

- A typed `PlatformConnection` model ([src/core/platform-connections/connection-types.ts](../../src/core/platform-connections/connection-types.ts)).
- A `ConnectionProvider` interface with a `MockConnectionProvider` that returns `not_connected` rows for every channel.
- The full set of statuses, capabilities, planned OAuth scopes, errors, and policy constants.
- A minimal Platform connections section on `/settings` that lists every channel with its current status and a disabled "Connect via official OAuth" button.

## What does not ship today

- No real OAuth flow.
- No token storage. None.
- No registered platform OAuth apps.
- No publishing.

## Connection model

```ts
interface PlatformConnection {
  id: string;
  workspaceId: string;
  channel: "reddit" | "x" | "linkedin" | "google";
  accountId: string | null;
  accountHandle: string | null;
  displayName: string | null;
  connectionStatus: PlatformConnectionStatus;
  scopes: string[];
  connectedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastCheckedAt: string | null;
  healthStatus: "healthy" | "warning" | "broken";
  capabilities: PlatformCapability[];
}
```

## Statuses

`not_connected`, `ready_to_connect`, `connected`, `expired`, `revoked`, `error`, `disabled`.

Each carries a human-readable label and a one-sentence user hint stored in [connection-status.ts](../../src/core/platform-connections/connection-status.ts). Internal codes like "invalid_grant" or "token hydration failed" never leak to the UI.

## Trust posture

[connection-policy.ts](../../src/core/platform-connections/connection-policy.ts) encodes:

- Signal **never** asks for platform passwords, cookies, session tokens, 2FA codes, or recovery codes.
- The only authorization model is official OAuth.
- Tokens, when implemented, are stored server-side. The browser never sees them.
- Founders can revoke any connection at any time.
- Scope changes require explicit reauthorization.

## Future flow

1. Founder clicks **Connect via official OAuth** on the platform card.
2. Browser redirects to the platform's authorization endpoint.
3. Platform shows its own consent screen with scopes.
4. Platform redirects back to a Signal server endpoint with an authorization code.
5. Server exchanges the code for tokens, stores them encrypted, writes a `connected` row to `platform_connections`.
6. UI returns to `/settings` showing the connection as **Connected**.

End-to-end target: under 2 minutes, mobile-friendly.

## Capabilities (planned)

See [platform-capability-matrix.md](./platform-capability-matrix.md) for the full per-channel matrix. Short version:

- **Reddit** — read profile (planned), publish (future), comments (future), metrics (limited).
- **X** — read profile (planned), posting (future), threads (future), metrics (future).
- **LinkedIn** — read profile (planned), publishing (limited), comments (limited).
- **Google visibility** — search/discoverability only. No social publishing model. Stays out of the social channel set.

## See also

- [platform-capability-matrix.md](./platform-capability-matrix.md)
- [oauth-first-principle.md](./oauth-first-principle.md)
- [../safety/account-health-first.md](../safety/account-health-first.md)
