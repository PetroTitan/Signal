# Pre-final cleanup

This phase removed visual noise, fake operational scale, and demo-template aesthetics from Signal.

The goal: make the product feel like a calm operational instrument — closer to Linear or Stripe — rather than a generic admin dashboard.

## What changed

### Mock data shrank

Volume targets are now deliberately small:

| Surface | Before | After |
|---|---|---|
| Weekly plan items | 9 | 4 |
| Source insights | 11 | 5 |
| Discussion seeds | 10 | 3 |
| Content assets | 18 | 6 |
| Risk events | 7 | 3 |
| Growth accounts | 8 | 5 |

Synthetic handles (`u/wmi_observer`, `printerapps_help`, `PDF tools support`, etc.) were removed. Remaining accounts use believable identities only: `@petro_helperg`, `petro-helperg`, `@webmasterid`, `@cashworkspace`, and one Reddit account explicitly in the `planned` state with no connected handle.

`oauthConnected` was set to `false` everywhere. Until real OAuth ships, no account claims to be connected.

### Pages stripped

Every operational surface now leads with a single calm list, not a stat strip.

- **/dashboard** — three blocks: cadence callout, next-best-actions, onboarding checklist. No stat tiles, no system-health grid, no items-needing-judgment panel, no what-changed feed, no platform-load chart, no upcoming list, no accounts panel, no risk panel, no analytics-readiness panel.
- **/opportunities** — one list of opportunities with filter chips. No stat strip, no intro card, no "cross-channel opportunity surface" prose.
- **/discussions** — one list with participate/watch/skip chips. No stat strip, no intro card.
- **/comments** — thread list with drafts inside. No stat strip, no intro card.
- **/content-intelligence** — insight list only. The draft pipeline preview, guardrail legend, memory summary grid, and pipeline bridge were removed.
- **/discoverability** — single list of top opportunities. No section explosion, no visibility ranking, no bridge card, no per-kind subsections.
- **/weekly-plan** — vertical card list, no nine-column table, no ten-block summary strip, no platform-distribution chart.
- **/approval-queue** — four action buttons per item (Approve, Soften, Move to backlog, Reject) instead of eight.
- **/scheduler** — kept the Mon-Sun grid; dropped the static cadence callout and the cadence-load strip (those signals live on the platform pages).
- **/backlog** — dropped the "Why we backlog" callout.
- **/platforms** — dropped the intro card; kept the four-card overview and comparison table.
- **/accounts** — replaced the inline OAuth notice with the shared TrustPanel; tightened topbar copy.

### Brand mark

The text "SG" placeholder in the sidebar and marketing layout was replaced with a small inline starburst SVG (`src/components/brand-mark.tsx`) using `currentColor` so it inherits page-level tone. The footer tagline on the sidebar ("Sustainable cadence — plans weekly...") was removed.

### Copy

- Page descriptions are one short sentence each.
- "Cross-channel opportunity surface", "infrastructure-grade", and similar jargon were removed from the visible UI.
- Topbar dropped the workspace-status dot (replaced by simpler title + actions).
- Search affordance in the topbar is now icon-only with an `aria-label`.

## Mock-data policy now in force

See [demo-data-policy.md](./demo-data-policy.md). Short version: the UI is designed to render gracefully with 1–2 items per surface. Density is not a feature.

## What this phase preserved

- The full operational engine: scheduler, risk, approval, content intelligence, comment intelligence, discoverability, store, onboarding.
- The platform command centers and Google visibility surface.
- The activity timeline, search, workflow map, and marketing pages.
- The Supabase planning docs.
- All trust messaging — surfaced through the shared `TrustPanel` instead of inline copy.
- Routes — every URL still resolves.

## What this phase did not do

- Did not install Supabase, OAuth, or any AI API.
- Did not change persistence (still mock).
- Did not remove product features; only removed visual density and synthetic counts.
