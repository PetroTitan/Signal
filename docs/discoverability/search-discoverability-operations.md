# Search & discoverability operations

Route: [/discoverability](../../src/app/(app)/discoverability/page.tsx)

The discoverability dashboard sits **next to** the social command centers, not inside them. It is the cross-channel lens that reasons about how content created for one purpose can serve another.

## What it surfaces

The page renders these sections:

- **Headline counters** — total opportunities, high/medium/low impact splits.
- **Search-to-social** — assets that rank well but have no social distribution.
- **Social-to-search** — recent assets with no amplification yet (`low_amplification` opportunities).
- **Topic cluster gaps** — clusters that need a companion guide or case study.
- **Evergreen distribution** — strong evergreen assets without recent amplification.
- **Refresh windows** — assets entering the recommended refresh band.
- **Visibility by product** — per-product discoverability score with a calm bar chart.
- **WebmasterID discoverability layer** — reserved live-signal slots.
- **Bridge** — links into Google visibility, weekly plan, and platforms overview.

## How signals are computed

`src/core/discoverability/`:

- `freshness.ts` — `calculateFreshnessStatus` classifies each asset as `fresh`, `evergreen`, `needs_refresh`, `stale`, or `under_promoted` from update age, incoming links, mock search position, and amplification counts.
- `visibility.ts` — `buildVisibilitySnapshot` produces a per-product composite score; `buildTopicalClusters` rolls assets into clusters with thin/missing coverage flags.
- `opportunities.ts` — `calculateDiscoverabilityOpportunities` walks the asset list and emits the typed `DiscoverabilityOpportunity` rows used by the UI. Output is sorted by impact.
- `youtube.ts` — `buildYouTubeIdeas` and `buildYouTubeCadencePlan` generate planning-only seeds per product.

Every function is pure and deterministic. No async, no clocks beyond the present time, no model calls.

## What is intentionally not automated

- No content publishing.
- No content updating.
- No indexing.
- No fake metrics — every unconnected slot says **"Data not yet connected"**.

The dashboard surfaces *suggestions*, not actions.

## Relation to the core

Discoverability is one half of the loop. The other half is approved social activity, which lives in the weekly planner and the social command centers.

When a `search-to-social` opportunity is approved, it becomes a normal `WeeklyPlanItem` and travels through the existing approval engine, scheduler, and risk engine. There is no separate "publish" path here.

## Future integrations

- **WebmasterID** — the live discoverability layer fills the placeholder slots.
- **Google Search Console** — adds real search position, impressions, and click data behind OAuth.
- **YouTube** — adds engagement and watch-time signals behind OAuth.

Until then, the dashboard is honest about what it has: a calm view of mock content state.
