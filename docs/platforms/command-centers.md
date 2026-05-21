# Platform command centers

The [/platforms](../../src/app/(app)/platforms/page.tsx) route hosts an overview of all four command centers and a comparison table. Each surface has its own route below it:

- [/platforms/reddit](../../src/app/(app)/platforms/reddit/page.tsx) — social
- [/platforms/x](../../src/app/(app)/platforms/x/page.tsx) — social
- [/platforms/linkedin](../../src/app/(app)/platforms/linkedin/page.tsx) — social
- [/platforms/google](../../src/app/(app)/platforms/google/page.tsx) — search & discoverability

A separate top-level route, [/discoverability](../../src/app/(app)/discoverability/page.tsx), hosts the cross-channel discoverability dashboard.

## Social vs discoverability

Signal splits the four command centers into two layers:

- **Social** — Reddit, X, LinkedIn. Share the social `PlatformId` union. Items flow through the weekly planner, approval queue, scheduler, and risk engine. Each has a strategy, cadence policy, content formats, risk rules, and a 10-module playbook.
- **Search & discoverability** — Google. Does **not** go through the social weekly-plan pipeline. Reasons about content assets, freshness, topical coverage, internal linking, and amplification.

This split is deliberate. Treating Google as a "social platform" would force a publishing model onto a search surface and dilute the operational core. See [google-visibility-command-center.md](./google-visibility-command-center.md) for the longer reasoning.

## What a social command center is

A social command center is a platform-specific lens over Signal's shared state. It does not duplicate the weekly planner or the approval queue — it reads from them and filters to one platform.

Each social command center renders:

- A strategy header explaining the platform's role.
- Live stats: readiness, eligible accounts, scheduled items, backlog count, risk count, cadence load.
- Recommendations (info / warn / block) computed from the current state.
- A platform-specific quantitative panel (Reddit's comments-first ratio, X's format mix and account velocity, LinkedIn's polish checklist).
- The accounts on this platform with eligibility chips.
- The content queue for this platform.
- The platform-specific risk rules.
- A 10-module playbook (`active` modules read from live data; `passive` modules are guidance; `placeholder` modules are reserved for future API integrations).
- Platform-specific opportunities (Reddit subreddits, X hook seeds, LinkedIn essay seeds).
- Content format reference.
- Analytics placeholder.
- OAuth-not-yet-enabled card.

## What the Google command center is

The Google command center is a different shape. It renders ten modules tuned for search and discoverability operations: search visibility, content freshness, discoverability signals, topical coverage, internal linking, evergreen content, under-promoted content, YouTube ecosystem planning, publishing freshness, and a WebmasterID insights placeholder. There is no cadence load, no risk score, no per-account scheduling.

## Implementation map

```
src/types/command-center.ts                — social command-center domain types
src/types/discoverability.ts               — search/discoverability types
src/core/platforms/                         — social strategy, cadence, risk, playbook, opportunities
src/core/discoverability/                   — freshness, visibility, opportunities, youtube
src/components/command-center.tsx          — shared building blocks for social command centers
src/lib/mock/content-assets.ts             — mock content assets used by the discoverability layer
src/app/(app)/platforms/
  page.tsx                                  — overview with all four cards
  reddit/page.tsx                           — social
  x/page.tsx                                — social
  linkedin/page.tsx                         — social
  google/page.tsx                           — search & discoverability
src/app/(app)/discoverability/page.tsx     — top-level cross-channel dashboard
```

## Voice and tone

Every command center uses the same calm language as the rest of Signal:

- "Sustainable cadence."
- "Move to the backlog."
- "Recommended cooldown."
- "Data not yet connected."

Never: "spam," "automation," "blast," "boost," "unlimited."

## See also

- [reddit-command-center.md](./reddit-command-center.md)
- [x-command-center.md](./x-command-center.md)
- [linkedin-command-center.md](./linkedin-command-center.md)
- [google-visibility-command-center.md](./google-visibility-command-center.md)
- [../discoverability/search-discoverability-operations.md](../discoverability/search-discoverability-operations.md)
- [oauth-first-principle.md](./oauth-first-principle.md)
- [../architecture/one-core-platform-command-centers.md](../architecture/one-core-platform-command-centers.md)
