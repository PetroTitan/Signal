# Platform command centers

The [/platforms](../../src/app/(app)/platforms/page.tsx) route hosts an overview of all three platform command centers and a comparison table. Each platform has its own route below it:

- [/platforms/reddit](../../src/app/(app)/platforms/reddit/page.tsx)
- [/platforms/x](../../src/app/(app)/platforms/x/page.tsx)
- [/platforms/linkedin](../../src/app/(app)/platforms/linkedin/page.tsx)

## What a command center is

A command center is a platform-specific lens over Signal's shared state. It does not duplicate the weekly planner or the approval queue — it reads from them and filters to one platform.

Each command center renders:

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

## Implementation map

```
src/types/command-center.ts        — domain types
src/core/platforms/
  strategy.ts                       — per-platform strategy, cadence, content formats, risk rules, playbook
  opportunities.ts                  — per-platform opportunity prompts
  readiness.ts                      — platform-level readiness snapshot
  load.ts                           — platform cadence load
  recommendations.ts                — action recommendations from live state
  index.ts                          — public API
src/components/command-center.tsx  — shared building blocks consumed by every platform page
src/app/(app)/platforms/
  page.tsx                          — overview
  reddit/page.tsx
  x/page.tsx
  linkedin/page.tsx
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
- [oauth-first-principle.md](./oauth-first-principle.md)
- [../architecture/one-core-platform-command-centers.md](../architecture/one-core-platform-command-centers.md)
