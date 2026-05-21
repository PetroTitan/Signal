# Operational stabilization

Phase 7 stabilizes Signal as a coherent operations system before any external integration (Supabase, OAuth, AI APIs, publishing) lands. The risk Signal needs to manage from here on is not "missing features" — it's complexity, navigation overload, and weak explainability.

## What stabilization added

1. **Operations dashboard panels** — the dashboard now leads with `NextBestActions`, `SystemHealth`, `WhatChangedThisWeek`, and `ItemsNeedingJudgment`. The founder lands on actionable judgment surfaces before scrolling into the legacy stat tiles.
2. **Explainability primitives** — `Explain` + eight named `Why*` wrappers (in `src/components/explain.tsx`) give every engine a calm, consistent way to surface "why this happened" inline.
3. **Activity timeline** — `/activity` derives a single chronological event stream from the live state and mock libraries. Layer and severity filters. No fake analytics.
4. **Internal search** — `/search` reaches across products, accounts, items, backlog, insights, content assets, risk signals, and internal docs. Deterministic ranking, no external service.
5. **Workflow map** — `/workflow` documents the twelve-stage operating loop with inputs, outputs, and links into each surface. Useful for founder, team, and reviewer onboarding.
6. **Navigation simplification** — sidebar reorganized into four groups: Operate, Intelligence, Platforms, Configure. Routes preserved; grouping improved.
7. **Shared primitives** — `EmptyState`, `SectionHeader`, and the explainability cards reduce duplication across the existing pages.

## Why this comes before Supabase

The persistence layer is the most invasive integration. Adding it before the operations model is stable causes the worst kind of churn — re-modeling tables every time a UI flow shifts. The state-readiness audit ([state-readiness-audit.md](./state-readiness-audit.md)) captures the current entity boundaries so the eventual migration is straight-shaped.

## Routes added or upgraded

| Route | Status |
|---|---|
| `/dashboard` | Upgraded with four operational panels and a topbar search affordance. |
| `/activity` | New — operational timeline. |
| `/search` | New — cross-entity internal search. |
| `/workflow` | New — twelve-stage flow documentation. |

## Files added or upgraded

```
src/components/explain.tsx
src/components/empty-state.tsx
src/components/section-header.tsx
src/components/operations-panels.tsx
src/components/sidebar.tsx                 (reorganized)
src/components/topbar.tsx                  (search affordance)
src/types/activity.ts
src/core/activity/                          (timeline derivation)
src/core/search/                            (cross-entity search)
src/app/(app)/activity/page.tsx
src/app/(app)/search/page.tsx
src/app/(app)/workflow/page.tsx
src/app/(app)/dashboard/page.tsx           (new panels)
```

## What is intentionally not in this layer yet

- Supabase persistence.
- Real OAuth integrations.
- Real AI API calls in the explainability layer (every reason string is a template surface today).
- Real-time activity streaming.
- Live cross-platform search.

Each of these is reserved for a later phase. The operational layer is built so they can land without rewriting any page.
