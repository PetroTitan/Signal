# Workspace region architecture

Signal operates as a stable regional identity. Every workspace picks one region and one timezone, and the system uses that consistently. This is operational infrastructure, not anti-detect tooling.

## What this layer is

- Workspace-level region selection (US East, EU West, Japan, etc.).
- Default timezone, language, and business-hour publishing windows per region.
- Three geo modes: `local_only`, `regional_operations`, `international_operations`.
- A deterministic region-consistency score and a validation pass.
- An optional outbound network profile for businesses that operate from a different network than the device running Signal.

## What this layer is not

- Not stealth automation.
- Not anti-detect infrastructure.
- Not fingerprint spoofing.
- Not browser masking.
- Not cookie or session management.
- Not proxy farming.
- Not rotation spam.
- Not platform bypass tooling.

If a future requirement looks like one of those, the requirement is wrong.

## Schema

`WorkspaceRegion` carries:

| Field | Purpose |
| --- | --- |
| `workspaceRegion` | The operational region. One value, stable. |
| `timezone` | IANA timezone (e.g. `America/New_York`). |
| `primaryLanguage` | BCP-47 code (e.g. `en-US`, `ja-JP`). |
| `publishingRegion` | The region to publish from. Usually equals `workspaceRegion`. |
| `regionalRoutingEnabled` | Whether outbound traffic uses a network profile. |
| `networkProfileId` | Optional ID of the active network profile. |
| `preferredPublishingWindows` | Calm regional windows (defaults provided). |
| `geoMode` | `local_only` \| `regional_operations` \| `international_operations`. |
| `regionConsistencyScore` | Deterministic 0–1 score from `scoreRegionConsistency`. |

It also carries `schemaVersion`, `lastUpdatedAt`, and `active` — the same evolution shape used across Signal's memory layer.

## Supported regions

Defined in `REGION_METADATA` (`src/core/geo/region-policy.ts`):

- `us_east`, `us_central`, `us_west` — US business cadence, English (US).
- `eu_west`, `eu_central` — European business cadence, English (GB) by default.
- `uk` — UK business cadence, English (GB).
- `jp` — Calm Japanese cadence, Japanese.
- `apac` — Mixed APAC cadence.
- `global` — UTC working hours, neutral defaults.

Each region carries its default timezone, default language, business-hour bounds, and a cadence profile.

## Geo modes

| Mode | Behavior |
| --- | --- |
| `local_only` | One region. Publishing region must equal workspace region. |
| `regional_operations` | One broad region (e.g. US, EU, APAC). Routing stays stable. |
| `international_operations` | Multiple regions. Each connection sets its own stable region. |

The default is `local_only`. Switching modes is a deliberate user action, surfaced in the network settings page.

## Publishing windows

`DEFAULT_PUBLISHING_WINDOWS` in `src/core/geo/timezone-routing.ts` ships calm defaults per region:

- US regions: morning, lunch, evening operator window.
- EU/UK: morning and afternoon workday.
- Japan: JST morning and JST afternoon.
- APAC: local morning and afternoon.
- Global: a single UTC working window.

Windows are stored as `{ label, startHourLocal, endHourLocal, daysOfWeek }`. They are guidance for the scheduler — nothing publishes automatically.

## Operating principles

Encoded in `REGION_POLICY_PRINCIPLES`:

1. A workspace has one stable region. No random country switching.
2. Routing is workspace-level, not per-request. No rotation pools.
3. Outbound network profiles are optional. Most workspaces never need one.
4. Regional routing never bypasses approval, cadence, or risk checks.
5. Region changes are logged. The consistency engine flags unstable switching.
6. Credentials are never present in the client; the UI sees masked placeholders.

## See also

- [./regional-routing.md](./regional-routing.md)
- [./network-profile-system.md](./network-profile-system.md)
- [../safety/region-consistency.md](../safety/region-consistency.md)
- [../platforms/geo-aware-operations.md](../platforms/geo-aware-operations.md)
