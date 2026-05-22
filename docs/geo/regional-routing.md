# Regional routing

Signal supports workspace-level regional routing: one stable network identity per workspace, optionally backed by an outbound network profile. This is not rotation, not pooling, not anti-detect.

## What regional routing controls

- Which region the workspace operates from.
- Which timezone publishing windows are anchored to.
- Which language the platform-adaptation layer should bias toward.
- Optionally, which outbound network the server uses when reaching platform APIs.

Nothing about regional routing changes the approval workflow, cadence protection, risk engine, or account health checks. Those remain active for every operation.

## Routing decisions

The `RegionalRoutingDecision` type carries the four fields any routed operation cares about:

| Field | Notes |
| --- | --- |
| `region` | One of the supported regions. |
| `timezone` | The IANA timezone to anchor windows to. |
| `networkProfileId` | Null when routing is off; otherwise the active profile ID. |
| `reason` | A short human-readable explanation. |

Routing is deterministic. The same configuration always produces the same decision.

## When routing is off

If `regionalRoutingEnabled` is false:

- Outbound traffic uses the server's default network.
- The publishing region and timezone still apply to windows and adaptation.
- The routing-stability signal in the consistency engine is treated as a pass.

This is the default for almost every workspace.

## When routing is on

If `regionalRoutingEnabled` is true:

- Exactly one network profile is active.
- The profile's region must match `workspaceRegion`.
- The profile is opt-in, configured once, and never rotates.
- The consistency engine flags any mismatch between profile region and workspace region.

## Geo modes and routing

| Geo mode | Publishing region | Routing |
| --- | --- | --- |
| `local_only` | Must equal workspace region | Optional |
| `regional_operations` | Same broad region as workspace | Optional |
| `international_operations` | May differ from workspace region | Each connection sets its own profile, stable per connection |

International mode is the only mode where workspace and publishing region can diverge — and even then, each connection still anchors to one stable profile.

## What routing never does

- It does not pool, rotate, or shuffle network identities.
- It does not bypass cadence or risk.
- It does not modify request headers beyond the platform SDK defaults.
- It does not store passwords, cookies, session tokens, 2FA codes, or recovery codes.
- It does not enable autonomous publishing.

## Validation

`validateWorkspaceRegion` and `validateNetworkProfile` (`src/core/geo/geo-validation.ts`) check:

- All required fields are present.
- Timezone matches the chosen region's continent.
- Routing disabled + profile attached → flagged.
- Local-only + publishing region differs from workspace region → flagged.
- Network profile: protocol is HTTP/HTTPS/SOCKS5, host looks like a hostname, port in `[1, 65535]`.

Validation messages are user-friendly, not technical.

## See also

- [./workspace-region-architecture.md](./workspace-region-architecture.md)
- [./network-profile-system.md](./network-profile-system.md)
- [../safety/region-consistency.md](../safety/region-consistency.md)
