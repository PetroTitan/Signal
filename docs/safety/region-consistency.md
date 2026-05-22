# Region consistency

Deterministic scoring of a workspace's regional identity. The engine produces a 0–1 score, a level (`stable` / `drifting` / `inconsistent`), and a short list of reasons. No model calls, no randomness.

## The signals

`scoreRegionConsistency()` (`src/core/geo/region-consistency.ts`) checks six signals, each with a weight that sums to 1.0:

| Signal | Weight | Pass condition |
| --- | --- | --- |
| `timezone_alignment` | 0.20 | Workspace timezone matches the chosen region's continent. |
| `publishing_window_consistency` | 0.15 | All windows fall within (region business start − 1) to (region business end + 3). |
| `region_stability` | 0.20 | At most one distinct region across the workspace region and recent history. |
| `routing_stability` | 0.15 | If routing is enabled, an active profile matches the workspace region. |
| `cadence_consistency` | 0.15 | Between 1 and 4 publishing windows defined. |
| `language_alignment` | 0.15 | Primary language matches the region's default language family. |

The score is the sum of passing weights.

## Levels

| Score | Level | Meaning |
| --- | --- | --- |
| `≥ 0.80` | `stable` | Region identity is consistent. |
| `0.55 – 0.79` | `drifting` | One or two signals are slipping. |
| `< 0.55` | `inconsistent` | Multiple signals fail; investigate. |

The `summary` string is human-readable and ready to render: e.g. *"Stable United States — East operational identity"*.

## Why this matters

A stable regional identity is operationally healthier than an unstable one. Platforms favor consistency. Audiences favor predictability. Signal's cadence and risk engines both work better when the workspace's region does not change underneath them.

The consistency engine is the first surface that will flag an unstable configuration — not as a stealth signal, but as an operational quality signal.

## What it never does

- Score does not influence whether a publish happens. Approval is the only gate that does that.
- Score is not displayed to platform connections or external services.
- Score does not include any inference about the user's real location.
- Score is not affected by network conditions, latency, or transient errors.

## Inputs

`scoreRegionConsistency({ workspaceRegion, networkProfile, recentHistory })`:

- `workspaceRegion` — current `WorkspaceRegion`.
- `networkProfile` — current active profile or null.
- `recentHistory` — recent `{ region, observedAt }` samples (e.g. last 30 days). The history is bounded by the application; the engine just reads it.

## Determinism

Same inputs → same outputs. The engine performs no I/O.

## See also

- [../geo/workspace-region-architecture.md](../geo/workspace-region-architecture.md)
- [../geo/regional-routing.md](../geo/regional-routing.md)
- [./account-health-first.md](./account-health-first.md)
- [./operational-safety-layer.md](./operational-safety-layer.md)
