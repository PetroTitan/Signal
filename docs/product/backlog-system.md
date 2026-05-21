# Backlog system

The backlog is where Signal puts items it does not publish this week. It is not a trash can — it is a holding queue. The point is that good content does not have to be fired the moment it exists.

## What can land in the backlog

- An item the founder explicitly saved during approval.
- An item the system flagged as exceeding platform cadence.
- An item on an account that is still in setup.
- An item that would create direct-link saturation if published.

## Shape

```ts
interface BacklogItem {
  id: string;
  workspaceId: string;
  accountId: string;
  productId: string;
  platform: PlatformId;
  contentType: ContentType;
  draft: ContentDraft;
  risk: RiskScore;
  movedFromPlanItemId: string | null;  // null for seeded items
  reason: string;
  movedAt: string;
}
```

## What happens when you restore an item

1. The backlog item is converted back to a `WeeklyPlanItem` in `pending_approval` status, attached to the current plan.
2. The scheduler redistributes the entire active plan (excluding any items already in `backlog`) — the restored item takes a safe slot, others may shift.
3. The risk engine rescores the week.
4. The backlog entry is removed.

This keeps the cadence safe: restoring something never forces a same-day double-post or an over-cap platform.

## Backlog UI

- `/backlog` is the dedicated page: held items at the top, items moved off the current week shown below.
- The scheduler also shows a backlog rail at the bottom so it is visible during planning.
- Restoring is a single click; the page shows the reason the item was held so the founder can decide if conditions have changed.

## What the backlog never does

- It never auto-restores an item.
- It never drops or expires an item.
- It does not have a "publish from backlog" shortcut. Backlogged items must pass back through the approval queue.
