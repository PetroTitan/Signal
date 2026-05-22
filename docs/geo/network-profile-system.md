# Network profile system

Optional outbound network configuration for workspaces that operate from a different network than the device running Signal. This is a stable, workspace-level identity — not a proxy farm, not a rotation pool, not anti-detect tooling.

## The model

`NetworkProfile` (`src/types/geo/network-profile.ts`):

| Field | Purpose |
| --- | --- |
| `id` | Stable profile identifier. |
| `workspaceId` | Owning workspace. |
| `label` | Human-readable name (e.g. "US East publishing route"). |
| `region` | The supported region this profile serves. |
| `protocol` | `http` \| `https` \| `socks5`. |
| `host` | Hostname or IP. |
| `port` | Integer in `[1, 65535]`. |
| `username` | Optional. |
| `encryptedPasswordPlaceholder` | The UI surface for masked credentials. Never the plaintext value. |
| `timezone` | Profile timezone (usually matches the region default). |
| `language` | Profile language. |
| `active` | Soft toggle. |

It also carries `schemaVersion`, `createdAt`, `updatedAt`.

## What the UI sees

The client never receives plaintext credentials. The settings UI displays a masked placeholder (`***` or similar) for the password field and, when listing profiles, exposes a `NetworkProfileSummary` that strips the username and any credential-shaped field. `summarizeNetworkProfile()` in `src/core/geo/mock-workspace-region.ts` enforces this in code.

## Storage model

When Supabase persistence ships:

- Plaintext credentials are encrypted server-side with a workspace-scoped KMS key.
- The database column for the encrypted blob is opaque; reads from the API return the placeholder only.
- Decryption happens only on the outbound request path, server-side, never in any route that returns data to the client.
- Audit rows log create / rotate / revoke events, never the values.

This is documented alongside the OAuth token storage plan in [../database/oauth-token-storage-plan.md](../database/oauth-token-storage-plan.md).

## Validation

`validateNetworkProfile` enforces:

- Protocol is one of HTTP / HTTPS / SOCKS5.
- Host looks like a hostname or IP (`[A-Za-z0-9._-]+`).
- Port is an integer in `[1, 65535]`.
- Label has a sane length.

The settings UI displays validation messages inline, never with technical jargon.

## What network profiles are not

- Not rotation. Each workspace has at most one active profile at a time.
- Not a marketplace. Signal does not bundle proxy lists or vendors.
- Not browser-level. The profile applies to server-side outbound calls only.
- Not a stealth tool. The platform sees the same authenticated OAuth identity it always sees.

## What never gets stored

- Passwords (only encrypted blobs server-side).
- Cookies, session tokens, 2FA codes, recovery codes.
- Browser fingerprints, anti-detect profiles.
- Rotation schedules or proxy pools.

If a future feature looks like it requires one of these, the feature is wrong.

## Operational scope

Most workspaces will never need a network profile. The feature exists for businesses that genuinely operate from a different region than the device running Signal — and even then, the profile is configured once and remains stable. There is no "automatic" mode.

## See also

- [./workspace-region-architecture.md](./workspace-region-architecture.md)
- [./regional-routing.md](./regional-routing.md)
- [../safety/region-consistency.md](../safety/region-consistency.md)
- [../platforms/oauth-first-principle.md](../platforms/oauth-first-principle.md)
