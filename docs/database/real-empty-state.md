# Real empty state from DB

Phase C wires several surfaces to read from Supabase. When the workspace has no data, those surfaces render honest empty states — not fake fixtures, not demo arrays.

## Surfaces converted to DB reads

| Route | Source | Empty state |
| --- | --- | --- |
| `/products` | `listProducts(workspaceId)` | "No products yet" + create form |
| `/accounts` | `listAccounts(workspaceId)` | "No connected accounts yet" + create form |
| `/activity` | `listRecentActivity(workspaceId)` | "No activity yet" |
| `/settings` (region & locale) | `getSettings(workspaceId)` from layout | Empty form fields |

Each page also handles two failure modes:

1. Supabase env not configured → render a config notice.
2. No workspace yet → render a one-line message ("Create a workspace from the dashboard.").

## What stays on the React store

These surfaces still render from the in-memory React store (which is empty in real mode, demo-seeded in demo mode) until a later phase migrates them:

- `/dashboard`
- `/weekly-plan`, `/approval-queue`, `/scheduler`, `/backlog`
- `/platforms`, `/platforms/{reddit,x,linkedin,google}`
- `/content-intelligence`, `/comments`, `/discussions`, `/opportunities`, `/discoverability`
- `/risk-center`
- `/settings/network`, `/settings/ai-memory`
- `/accounts/[id]`, `/accounts/new` (legacy wizard)

This split is intentional: Phase C only persists workspaces, products, accounts, settings, and activity. Engine-driven surfaces (weekly plan, scheduler, risk center) still need their data model committed to DB before they can read from it.

## Demo mode

`NEXT_PUBLIC_SIGNAL_DEMO_MODE` continues to gate demo fixtures for the store-backed surfaces. Demo mode does **not** seed Phase C tables — the products and accounts a demo user sees are still the mock arrays from `src/lib/mock/`. Real workspaces created during demo-mode browsing remain in the database.

In practice:

- A logged-out viewer never sees DB data (middleware redirects to `/login`).
- A logged-in user with demo mode off sees their actual workspace data + honest empty states.
- A logged-in user with demo mode on sees their actual workspace data on the DB-backed pages, plus mock fixtures on the store-backed pages, with `DemoLabel` chips above the latter.

## Honesty rules preserved

Phase B's promise — "no fabricated handles, no fake metrics in normal mode" — still holds:

- The new `/accounts` page lists only accounts the user created, all in `not_connected` state.
- The new `/products` page lists only products the user created.
- The new `/activity` page lists only events recorded by the application — workspace created, product created, account created, settings updated.

No fixtures bleed into normal mode. No fabricated analytics anywhere.

## See also

- [./supabase-auth-foundation.md](./supabase-auth-foundation.md)
- [./repository-layer.md](./repository-layer.md)
- [../product/demo-data-policy.md](../product/demo-data-policy.md)
- [../product/empty-state-honesty.md](../product/empty-state-honesty.md)
