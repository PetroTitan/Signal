# Content memory

The content memory layer is the small, deterministic accountant Signal uses to avoid repeating itself. It is not "AI memory" — there is no embedding, no semantic store. It tracks insight usage, repeated hooks, stale topics, and underused opportunities from the current weekly plan.

## What it watches

- **Insight usage** — which insights produced an item in the current week's plan, on which channel.
- **Repeated hooks** — exact hook reuse across plan items. Surfaced on the content intelligence page.
- **Evergreen availability** — insights with high evergreen score that haven't been used yet.
- **Stale insights** — insights older than the 180-day window that haven't been refreshed.
- **Underused insights** — insights with strong conversation/evergreen potential that haven't been mapped to plan items.

## Functions

```ts
buildMemoryRecords({ insights, items, weekStartIso })
  // -> ContentMemoryRecord[]
summarizeMemory({ insights, items, weekStartIso })
  // -> ContentMemorySummary
recentlyUsedHooks(items)
  // -> string[]
```

All three are pure and live in [src/core/content-intelligence/memory.ts](../../src/core/content-intelligence/memory.ts).

## How it integrates

- The opportunity engine consumes `recentlyUsedHooks(items)` to flag candidate opportunities whose title overlaps with a hook already in the plan.
- The draft pipeline passes `knownHooks` into adapter calls; the guardrail layer flags exact duplicates.
- The content intelligence page renders a memory summary (used, untapped, evergreen-available, underused, stale, repeated hooks).
- The conversation risk layer uses a parallel `knownBodies` list to detect comment phrasing reused across discussions.

## What this layer never does

- It does not delete insights.
- It does not auto-rotate hooks.
- It does not prevent the founder from approving a "repeated" item.
- It does not infer semantic similarity — only exact string matches and obvious overlaps.

When persistence ships, `ContentMemoryRecord` is the shape that will be stored. Until then, the summary is recomputed on every render from the live plan.
