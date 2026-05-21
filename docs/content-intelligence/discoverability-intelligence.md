# Discoverability intelligence

Signal's discoverability intelligence is the layer that pairs insights with content assets to detect search-to-social opportunities, topic gaps, and freshness windows. It extends — does not replace — the existing discoverability dashboard.

## How it connects

```
SourceInsight  →  Google adapter  →  DiscoverabilityOpportunity[]
SourceInsight  →  Opportunity engine  →  ContentOpportunity (channel: google, kind: discoverability_signal)
ContentAsset   →  freshness, visibility, opportunity scoring
```

The Google adapter ([src/core/platform-adapters/google.ts](../../src/core/platform-adapters/google.ts)) inspects an insight and the asset library to produce typed opportunities:

- `evergreen_distribution`
- `topic_cluster_gap`
- `freshness_refresh`
- `search_to_social`
- `internal_linking`

The opportunity engine produces a separate, channel-aware `ContentOpportunity` with kind `discoverability_signal` to make the insight visible on the cross-channel opportunities page.

## Scoring inputs

Per asset:

- update age (drives freshness verdict),
- incoming and outgoing internal-link counts,
- mock search position (1–100),
- per-platform amplification counts.

Per insight:

- discoverability potential,
- evergreen score,
- conversation score,
- freshness potential.

Pairing both sets of signals lets Signal surface, for example: "this insight has strong discoverability potential, but no asset covers the cluster — propose an evergreen guide."

## What this layer never does

- It never calls Google Search Console.
- It never fakes search rankings (mock positions are clearly mock).
- It never queues an automated refresh.
- It never publishes content.

Signal surfaces the *suggestion*. The founder decides.

## Future integration

When WebmasterID is connected:

- mock search positions are replaced with live data,
- amplification counts are wired to real platform engagement,
- the placeholder block under `/platforms/google` and `/discoverability` fills with live signals.

The discoverability code stays as-is.
