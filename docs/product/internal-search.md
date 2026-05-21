# Internal search

Route: [/search](../../src/app/(app)/search/page.tsx)

A small, deterministic search across the data Signal already holds. No external service. No vector store. No fuzzy ranking.

## What it searches

| Entity | Fields scored |
|---|---|
| Product | name, domain, positioning, category, content style, target audience |
| Account | display name, handle, role, status, platform |
| Plan item | hook, body, CTA, content type, platform, status |
| Backlog item | hook, body, reason, platform |
| Source insight | title, core insight, summary, category, audience |
| Content asset | title, summary, cluster, URL, kind |
| Risk event | summary, recommendation, category, level |
| Internal docs | known doc surfaces with curated tags |

## Ranking

Each token in the query is scored against each field:

| Match type | Score |
|---|---|
| Exact match | +6 |
| Field starts with token | +4 |
| Word-boundary match (` token ` or ` token` at end) | +3 |
| Substring match | +2 |

Scores sum across fields and tokens. Up to 60 results are returned, sorted by score.

## Filters

Above the result list, filter chips show the matched count per entity type and let the user narrow to one type at a time.

## Voice and tone

- The search box is the only input on the page.
- No "AI" branding.
- No suggestions that aren't grounded in real entities.
- Results link directly to the most useful surface for that entity (a product to `/products/[slug]`, an item to `/weekly-plan`, an insight to `/content-intelligence`, etc.).

## What this is not

- Not a command palette (yet). Could become one — the underlying `searchAll` function is the right primitive.
- Not a full-text search engine. There is no tokenization beyond whitespace and lowercase normalization.
- Not a similarity / embedding search. There is no semantic understanding.

## Topbar affordance

The topbar carries a small "Search" button on every authenticated route so the founder can reach the search surface without leaving context.

## Future evolution

When persistence ships, search reads from a database (or a small dedicated index) instead of the in-memory state. The surface stays the same. If a command palette ships later, it consumes the same `searchAll` core.
