# Google visibility command center

Route: [/platforms/google](../../src/app/(app)/platforms/google/page.tsx)

## Why Google is different

Google is **not** treated as a social publishing platform inside Signal.

The social platforms — Reddit, X, LinkedIn — share the social `PlatformId` union and run through the weekly planner, approval queue, scheduler, and risk engine. Google does not. It would be wrong to model search visibility as a "post cadence" — there is nothing to schedule, no per-post risk score, no per-account cooldown.

Instead, Google is a **search & discoverability operations** surface. It reasons about content assets, freshness, topical coverage, internal linking, and amplification across the other channels.

## Strategy

- **Strategic role:** visibility, content freshness, topical coverage, search-to-social loop.
- **Operational purpose:** identify discoverability opportunities and surface them calmly so the founder can plan refreshes and cross-channel amplification.
- **Cadence shape:** not a posting cadence. Per-asset refresh windows instead.
- **Voice:** n/a — this is a content/visibility layer, not a publishing one.

## What you see on the page

The command center renders the 10 required modules:

1. **Search visibility** — per-product mock snapshot (indexed ratio, fresh count, evergreen count, stale count, average mock position, composite score).
2. **Content freshness** — every asset with its freshness verdict and suggested refresh window.
3. **Discoverability signals** — opportunities derived from the local content list (search-to-social, evergreen distribution, internal linking, freshness refresh).
4. **Topical coverage** — per-cluster coverage with thin/missing flags.
5. **Internal linking opportunities** — assets with no incoming internal links.
6. **Evergreen content** — assets that hold position and have incoming links.
7. **Under-promoted content** — recent assets with no social amplification yet.
8. **YouTube ecosystem planning** — shorts, founder video, community update, and long-form ideas per product, plus a calm weekly target. Planning only.
9. **Publishing freshness** — time since the most recent update across the portfolio.
10. **WebmasterID insights placeholder** — reserved slots for live signals when WebmasterID is connected.

## What is intentionally not automated

- No Google Search Console API.
- No YouTube API.
- No indexing API.
- No automated indexing.
- No automated publishing.
- No automated content updates.
- No fake metrics.

Every signal is mock or derived from `src/lib/mock/content-assets.ts`. The WebmasterID placeholder shows `Data not yet connected` rather than fabricating numbers.

## YouTube ecosystem

The YouTube section is planning architecture only. It generates idea seeds (shorts, founder video, community update, long-form) and a calm weekly target per product. There is no API, no upload path, no video pipeline.

## Future integrations

- When WebmasterID is connected, the placeholder block fills with live discoverability signals.
- When Google Search Console becomes part of Signal, it goes through OAuth — no password, cookie, or session token storage. The `OAuthFutureCard` at the bottom states this explicitly.
- When YouTube becomes part of Signal, the same OAuth model applies. The planning architecture stays as-is.

## See also

- [search-discoverability-operations.md](../discoverability/search-discoverability-operations.md)
- [command-centers.md](./command-centers.md)
- [../architecture/one-core-platform-command-centers.md](../architecture/one-core-platform-command-centers.md)
