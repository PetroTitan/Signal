# One operational core, three platform command centers

Signal's architecture is intentionally split:

- **One operational core** — the weekly planner, approval engine, scheduler, risk engine, backlog, store, and onboarding all run independently of any platform.
- **Three platform command centers** — Reddit, X, and LinkedIn each have a route that interprets the same shared state through a platform-native lens.

Signal is not a generic universal social dashboard. Each platform has its own strategy, content formats, cadence policy, risk rules, and playbook. The command centers expose that surface without duplicating the workflow underneath.

## Why this shape

Two failure modes shaped the design:

1. **One generic dashboard** loses the texture of each platform. Reddit is community-first; X rewards replies; LinkedIn demands polish. A single feed-style UI flattens all of that into a posting queue.
2. **One product per platform** duplicates state and decisions. The founder would need to plan a Reddit week, an X week, and a LinkedIn week separately — and the risk engine would have to live in three places.

The split puts the **decisions** (approve, delay, redistribute, save to backlog) in one place and lets the **interpretation** of those decisions live per platform.

## What the core owns

Anything that mutates state, schedules an item, scores risk, or moves an item between statuses lives in:

- `src/core/scheduler/`
- `src/core/risk/`
- `src/core/approval/`
- `src/core/store/`
- `src/core/onboarding/`

Pages that use these — dashboard, weekly plan, approval queue, scheduler, backlog, risk center, accounts — work the same regardless of which platform is involved.

## What the platform command centers own

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

## What is intentionally not automated yet

Platform command centers do not:

- Publish content.
- Sign into a platform.
- Pull live engagement.
- Auto-restore items from the backlog.
- Generate new content with an LLM.

Each of these is reserved for future phases behind clearly named placeholders (e.g. the OAuth card, the `Data not yet connected` analytics block, and the `placeholder`-status playbook modules).

## Future OAuth and API integration boundaries

When a platform's official API ships:

- `getPlatformContentFormats`, `getPlatformPlaybook`, and `getPlatformRiskRules` stay where they are — they're operational policy.
- A new `PlatformAdapter` lives under `src/core/platforms/<platform>/adapter.ts` and implements `authorize()`, `publish()`, and `fetchEngagement()` (see [platform-adapters.md](../platforms/platform-adapters.md)).
- The OAuth card on each command center becomes the active connect surface.
- Analytics placeholders are replaced by data from WebmasterID once it is wired.

Until then, the command centers are lenses over the same store, not separate stacks.
