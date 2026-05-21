# One operational core, four platform command centers

Signal's architecture is intentionally split into three layers:

- **One operational core** — the weekly planner, approval engine, scheduler, risk engine, backlog, store, and onboarding all run independently of any platform.
- **Three social command centers** — Reddit, X, and LinkedIn each have a route that interprets the same shared state through a platform-native lens.
- **One search & discoverability surface** — Google, plus a top-level `/discoverability` dashboard.

Signal is not a generic universal social dashboard. Each platform has its own strategy, content formats, cadence policy, risk rules, and playbook. Google is not crammed into the social model; it sits as its own discoverability layer.

## Social vs discoverability

The four command centers split into two layers because they operate on different things:

| Aspect | Social (Reddit / X / LinkedIn) | Search (Google) |
|---|---|---|
| Unit of work | A post, thread, or reply on an account | A content asset on a domain |
| Cadence | Per-account per-week, with cooldown | Per-asset refresh windows |
| Approval | Item-level via the weekly approval queue | n/a — content is not approved here |
| Risk engine | Per-item, deterministic | n/a — opportunities, not risk |
| Scheduler | Time-of-day windows per platform | n/a |
| Pipeline | weekly planner → scheduler → publishing | discoverability lens → opportunity → social cross-reference |

Treating Google as a fourth social platform would force a publishing model onto a search surface and dilute the operational core. Treating the three social platforms identically would erase the texture that makes each one distinct.

## Why this shape

Two failure modes shaped the design:

1. **One generic dashboard** loses the texture of each platform. Reddit is community-first; X rewards replies; LinkedIn demands polish; Google is about visibility and freshness, not cadence. A single feed-style UI flattens all of that.
2. **One product per platform** duplicates state and decisions. The founder would need to plan a Reddit week, an X week, a LinkedIn week separately, and somehow integrate "SEO" alongside — and the risk engine would have to live in four places.

The split puts the **decisions** (approve, delay, redistribute, save to backlog) in one place and lets the **interpretation** of those decisions live per platform. Discoverability sits next to the social loop, not inside it.

## What the core owns

Anything that mutates state, schedules an item, scores risk, or moves an item between statuses lives in:

- `src/core/scheduler/`
- `src/core/risk/`
- `src/core/approval/`
- `src/core/store/`
- `src/core/onboarding/`

Pages that use these — dashboard, weekly plan, approval queue, scheduler, backlog, risk center, accounts — work the same regardless of which platform is involved.

## What the social command centers own

In `src/core/platforms/` and `src/components/command-center.tsx`:

- `getPlatformStrategy(platform)` — strategic role, voice, approval and scheduling behavior.
- `getPlatformCadencePolicy(platform)` — minimum hours, suggested cadence, max cadence, mode.
- `getPlatformContentFormats(platform)` — what kinds of content suit this platform.
- `getPlatformRiskRules(platform)` — platform-specific things the risk engine cares about.
- `getPlatformPlaybook(platform)` — 10 named modules per platform (some live, some passive, some placeholders).
- `getPlatformOpportunities(platform, products)` — surface-level prompts derived from product profiles.
- `getPlatformRecommendations({ platform, accounts, items, riskEvents, backlog })` — calm action recommendations rendered as a callout.
- `calculatePlatformReadiness(platform, accounts)` — platform-wide readiness snapshot.
- `calculatePlatformCadenceLoad(platform, items)` — platform cadence load summary.
- `groupWeeklyItemsByPlatform(items, platform)` — lens helper.

These are pure functions. They never mutate state.

## What the search & discoverability layer owns

In `src/core/discoverability/`:

- `calculateFreshnessStatus(asset)` — classifies an asset as fresh / evergreen / needs_refresh / stale / under_promoted from age, incoming links, mock search position, and amplification.
- `buildVisibilitySnapshot(productId, assets)` — per-product composite visibility score.
- `buildTopicalClusters(productId, assets)` — clusters with coverage flags.
- `calculateDiscoverabilityOpportunities(assets, products)` — typed opportunity rows (search-to-social, social-to-search, evergreen distribution, freshness refresh, internal linking, topic cluster gaps).
- `buildYouTubeIdeas(product)` and `buildYouTubeCadencePlan(product)` — planning-only seeds.

These are also pure functions and never mutate state.

## What is intentionally not automated yet

The command centers do not:

- Publish content.
- Sign into a platform.
- Pull live engagement.
- Auto-restore items from the backlog.
- Generate new content with an LLM.

The discoverability layer additionally does not:

- Call Google Search Console.
- Call the YouTube API.
- Call an indexing API.
- Auto-update content.

Each of these is reserved for future phases behind clearly named placeholders (the OAuth card, the `Data not yet connected` block, and `placeholder`-status playbook modules).

## Future OAuth and API integration boundaries

When a platform's official API ships:

- The pure getters in `src/core/platforms/` and `src/core/discoverability/` stay where they are — they're operational policy.
- A new `PlatformAdapter` lives under `src/core/platforms/<platform>/adapter.ts` and implements `authorize()`, `publish()`, and `fetchEngagement()` (see [platform-adapters.md](../platforms/platform-adapters.md)).
- For Google, the adapter implements `authorize()` and `fetchVisibility()`; no `publish()` exists by design.
- The OAuth card on each command center becomes the active connect surface.
- The WebmasterID placeholder block is replaced by live data once that integration is wired.

Until then, the command centers are lenses over the same store, not separate stacks.
