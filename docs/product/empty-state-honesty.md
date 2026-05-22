# Empty-state honesty

Signal's default state is empty. If the founder did not create an account, a product, or an item, the UI does not pretend one exists.

This document captures the decisions that made the product honest by default.

## The rule

If the founder did not:

- create it,
- connect it,
- import it,
- or explicitly turn on Demo data,

then it does not appear in the UI as if it were real operational data.

## How it works

A small `DemoMode` context (`src/core/demo-mode/`) carries a single boolean, persisted to `localStorage` under `signal:demo_mode`. It defaults to `false`.

- The `SignalShell` reads `demoMode`. When `false`, the store is seeded with empty arrays and empty maps for accounts, items, backlog, and products. When `true`, the existing mock seeds are used.
- The `useDemoData(real, fallback?)` helper in `src/lib/demo-data.ts` gates every page or component that still imports a mock collection directly (insights, discussions, content assets, risk events). When demo is off, the helper returns the fallback (default `[]`).
- A keyed remount on `<SignalProvider key={demoMode ? "demo" : "real"} …>` clears the in-memory store on every toggle, so flipping the switch is instant and clean.
- When demo is on, a small dark banner appears at the top of every page: **"Demo data — not connected to real accounts. Turn off in Settings."**

## Default UI surface (demo off)

| Route | What the founder sees |
|---|---|
| `/dashboard` | Welcome message + "Add your first account" + "Create a product profile" + a single calm OAuth-first note. |
| `/weekly-plan` | "No weekly plan yet" with Add product / Add account CTAs. |
| `/approval-queue` | "No items awaiting approval. Approved weekly plans will appear here after you generate drafts." |
| `/scheduler` | "Nothing scheduled yet." |
| `/backlog` | "Backlog is empty." |
| `/opportunities` | "No opportunities right now." |
| `/discussions` | "No discussions in this view." |
| `/comments` | "No drafts. Open discussions to see where to participate." |
| `/content-intelligence` | "No insights yet. Add one as a founder observation, product lesson, or support pattern." |
| `/discoverability` | "No discoverability opportunities right now. WebmasterID is not yet connected." |
| `/platforms/google` | The same surfaces, computed against zero assets. |
| `/risk-center` | Empty risk surface. |
| `/activity` | "No events match these filters." |
| `/accounts` | "No connected accounts yet" with Add account CTA. |
| `/products` | "No products yet" with explanation. |
| `/analytics` | "No analytics data yet. WebmasterID is not connected." |

The wizard at `/accounts/new` guards against the "no products" case: it shows "Add a product first" and links to `/products` instead of letting the founder hit a broken step.

## Default UI surface (demo on)

The same routes render the existing seed data (small, believable: 5 insights, 3 discussions, 6 content assets, 4 plan items, 5 accounts). A dark banner at the top of the page reads:

> Demo data — not connected to real accounts. Turn off in Settings.

The banner is unmissable. Nothing reads as real that isn't.

## What stays connected to real data

When the founder creates an account through `/accounts/new`, that account lands in the store immediately. It survives mode toggles for as long as the page session lasts (state lives in the React reducer; there's no persistence yet — that's Supabase territory). Accounts the founder creates are not labeled "Demo."

When persistence ships, accounts will live across sessions. The Demo Mode toggle stays: it controls whether the seed library is overlaid on top of real workspace data.

## What this layer never does

- Never fabricates engagement numbers, impressions, search positions, conversions, or any metric.
- Never claims an account is connected unless the founder explicitly connected it (today, no real connection path exists; tomorrow, OAuth).
- Never hides "Data not yet connected" labels behind charts.
- Never persists demo data alongside real data without a visible label.
- Never enables demo mode silently. The toggle is in Settings; the banner is global.

## Settings

`/settings` carries the Demo data switch as the first card. The label reads:

> Off by default. When off, Signal shows real empty states — no fake accounts, no synthetic queues, no fabricated metrics. Turn on to explore the workflow with sample data clearly labeled as demo.

Workspace footprint reads from the live store (`Object.values(state.productsById).length`, `Object.values(state.accountsById).length`), so the numbers reflect reality at all times.

## Why this matters

A product that needs synthetic accounts to look credible loses credibility the moment a real founder logs in with no accounts yet. Empty-by-default protects that first impression. The dark banner protects the rest.
