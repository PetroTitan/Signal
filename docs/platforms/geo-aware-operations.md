# Geo-aware platform operations

Platform adaptation in Signal is subtly geo-aware. The same product can read calm in Japan and direct in the US East without faking localization or pretending to be local.

## What "geo-aware" means here

The platform adaptation layer (`platform_adaptation` use case) receives three small bits of geo context:

- The workspace's region (e.g. `us_east`, `jp`, `eu_west`).
- The cadence profile for that region (US business / EU business / JP calm / APAC mixed / global).
- A short list of regional hints: tone, pacing, and discoverability.

The hints are deterministic. They come from `REGIONAL_CADENCE_PROFILES` in `src/core/geo/regional-cadence.ts`. The model never invents geo context; it receives a stable set of regional cues defined in code.

## Examples

US East:

- **Tone hints:** founder first-person; specific over general.
- **Pacing hints:** match US business hours; avoid late-night posts.
- **Discoverability hints:** consider US-centric search intent.

Japan:

- **Tone hints:** calm; polite; specific.
- **Pacing hints:** follow JST workday rhythm; lower posting frequency.
- **Discoverability hints:** consider local Japanese search intent.

EU West:

- **Tone hints:** measured; operational.
- **Pacing hints:** respect European workday rhythm.
- **Discoverability hints:** consider EU search intent and language variants.

These hints flow into the structured-output prompt contracts. They do not flow into freeform prose, and they do not expand the token budget.

## Suggested daily volume

`suggestedDailyVolumeFor(region)` returns a small integer:

- `jp` → 1 (calmer cadence).
- `us_business`, `eu_business`, `apac_mixed` → 2.
- `global` → 3.

This is guidance for the planner, not a hard ceiling. The workspace's `cadence_policy` and the per-account `accountWeeklyCount` checks remain authoritative.

## Discoverability awareness

For the Google discoverability surface specifically:

- The workspace region informs which SERP intent the content planner biases toward.
- The discoverability layer adds a regional context label (e.g. "Planned for US-centric search intent").
- Real metrics (rankings, traffic, indexed pages, impressions) remain "data not connected yet" until Search Console integration ships. No fake numbers.

## What geo-aware is not

- Not localization. Signal does not translate or transliterate.
- Not country impersonation. The platform sees the same authenticated identity it always sees.
- Not auto-posting timed to a region's local clock — the human still approves.
- Not based on inferred location. The user picks a region in settings.

## Operational scope

For a single-region workspace (`local_only`), the geo-aware behavior is barely visible: tone hints stay aligned with one region, publishing windows match the region's defaults. For a workspace running `international_operations`, the platform adaptation layer can produce subtly different framings for different regional connections — still without faking localization.

## See also

- [../geo/workspace-region-architecture.md](../geo/workspace-region-architecture.md)
- [../geo/regional-routing.md](../geo/regional-routing.md)
- [./platform-capability-matrix.md](./platform-capability-matrix.md)
- [../ai/prompt-contracts.md](../ai/prompt-contracts.md)
- [../discoverability/search-discoverability-operations.md](../discoverability/search-discoverability-operations.md)
