# Global activity timeline

Route: [/activity](../../src/app/(app)/activity/page.tsx)

The activity timeline is Signal's internal operational log. Every event is derived deterministically from the current state and the mock libraries — there is no event store yet, and no fake analytics.

## What appears in the timeline

The timeline aggregates events from these sources:

- **Insights** — every `SourceInsight` shows up as an `insight_created` event.
- **Accounts** — every `GrowthAccount` shows up as `account_created`. Accounts with a `lastActivityAt` also produce an `account_readiness_changed` event.
- **Weekly items** — every plan item produces a `draft_created` event. High/blocked-risk items additionally emit a `risk_flagged` event.
- **Approval events** — every `ApprovalEvent` from the store maps to `item_approved`, `item_rejected`, or `item_backlogged`.
- **Backlog items** — each held item maps to `item_backlogged`.
- **Schedule moves** — the most recent redistribution produces `schedule_redistributed` events.
- **Risk events** — every seeded `RiskEvent` produces a `risk_flagged` event.
- **Content opportunities** — the top two opportunities per insight per channel produce `opportunity_generated`.
- **Discoverability opportunities** — both insight-driven and asset-driven opportunities produce `discoverability_opportunity`.
- **Discussions** — every skipped discussion produces a `thread_skipped` event; matched discussions produce `comment_drafted`.

## Shape

Each event carries:

```ts
interface ActivityEvent {
  id: string;
  occurredAt: string;       // ISO timestamp
  type: ActivityEventType;
  entityType: ActivityEntityType;
  layer: ActivityLayer;     // core | platform_social | platform_search | intelligence | operations | configuration
  platform?: PlatformId | "google";
  productId?: string;
  severity: "info" | "ok" | "warn" | "block";
  title: string;
  explanation: string;
  link?: string;
}
```

## Filters

- **Layer** — Core, Operations, Intelligence, Social, Search, Configuration.
- **Severity** — Blocked, Warn, Info, OK.

The page renders the most recent 80 events to keep the surface focused.

## What this timeline is not

- Not a performance dashboard.
- Not a notification feed.
- Not an audit trail (though it overlaps).
- Not a real-time stream.

## What happens when persistence ships

The current derivation runs on every render. When Supabase lands, a persistent `activity_events` table replaces the derivation. The shape stays the same. The page consumes the same `ActivityEvent[]` it consumes today.
