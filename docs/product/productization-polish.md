# Productization polish

Phase 8 turns Signal from "advanced internal prototype" into "high-end operational SaaS product." The brief was intentionally narrow: no new engines, no integrations, no rewrites. Cohesion, consistency, trust, and onboarding clarity.

## What productization added

- **Shared trust panel** — one `TrustPanel` component, one trust-copy source of truth (`src/lib/trust-copy.ts`), one canonical voice across accounts, settings, and onboarding flows.
- **PageIntro** — small calm card used as the standard page intro across new and existing pages.
- **Onboarding checklist on the dashboard** — six steps from product configuration to weekly review, with a live progress bar and per-row deep link.
- **Public marketing surfaces** — `/about`, `/philosophy`, `/how-it-works`, `/security` in a `(marketing)` route group, outside the app shell, SEO-friendly and SSG-prerendered.
- **Skip-link + focus rings** — a global skip-link and clearer keyboard focus styles for every interactive element.
- **Semantic main landmark** — `<main id="main-content">` in the app shell and the marketing layout.

## What this phase did not do

- No Supabase. No OAuth integrations. No real AI APIs. No publishing. No Stripe.
- No design-system rebuild — the existing Tailwind tokens and calm palette were already in good shape; nothing was rewritten.
- No new engine. No new operational route in the app shell beyond the onboarding card.
- No marketing claims, fake metrics, fake testimonials, or fake users.

## Files added

```
src/lib/trust-copy.ts
src/components/trust-panel.tsx
src/components/page-intro.tsx
src/components/onboarding-checklist.tsx
src/app/(marketing)/layout.tsx
src/app/(marketing)/about/page.tsx
src/app/(marketing)/philosophy/page.tsx
src/app/(marketing)/how-it-works/page.tsx
src/app/(marketing)/security/page.tsx
docs/product/productization-polish.md
docs/product/design-system.md
docs/product/trust-and-safety.md
docs/product/onboarding-philosophy.md
docs/product/operational-ux.md
```

## Files touched (small, targeted)

- `src/app/globals.css` — focus-visible ring and `.skip-link` rule.
- `src/app/layout.tsx` — top-level skip link.
- `src/components/signal-shell.tsx` — `<main id="main-content">` landmark.
- `src/app/(app)/accounts/page.tsx` — replaced inline `OauthNotice` with the shared `TrustPanel`.
- `src/app/(app)/dashboard/page.tsx` — added the onboarding checklist at the end of the dashboard.

## Why the marketing surfaces live in a separate route group

`(app)` carries the authenticated shell (sidebar, mobile-nav, store provider). The marketing routes don't need any of that — they're public, fast, and SEO-friendly. Putting them in `(marketing)` keeps the app store out of their bundles and the sidebar out of their layout.

## Pre-Supabase readiness

The polish phase intentionally avoids introducing new state shapes. The state-readiness audit from Phase 7 still applies. When persistence ships:

- Marketing surfaces stay public, unchanged.
- The trust panel keeps the same voice — it never needs to change as integrations land.
- The onboarding checklist keeps its current shape; its `done` flags will come from real state rather than derived heuristics.
