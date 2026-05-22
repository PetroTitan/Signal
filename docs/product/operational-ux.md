# Operational UX

This document captures the voice and decisions behind Signal&apos;s operational surfaces — the dashboard, the approval queue, the scheduler, the comments/discussions surfaces, the platform command centers, the discoverability dashboard.

## What "operational" means here

Signal is a working surface for founders, not a feed. The UX is shaped to:

- support **review** (the founder is looking through a list of pending items),
- support **judgment** (every item carries enough context to decide),
- support **calm** (no urgency cues, no notifications, no streaks),
- support **scanning** (high-signal first, with consistent vocabulary).

## Dashboard ordering

The dashboard now leads with four operational panels in this order:

1. **NextBestActions** — what to review next, ordered by judgment cost.
2. **SystemHealth** — engine status (eligible accounts, risk signals, OAuth state).
3. **ItemsNeedingJudgment** — higher-risk pending items.
4. **WhatChangedThisWeek** — recent operational events.

These four panels answer:

- What requires attention?
- What is safe?
- What is blocked?
- What changed recently?

Stat tiles, pending list, platform load, and analytics readiness sit below. The onboarding checklist closes the page.

## Approval queue

The queue is intentionally calm. Every item card shows:

- platform, account, product, content type, scheduled time,
- the risk badge with score,
- the hook, body, and CTA,
- the risk reasons and the recommendation (when applicable),
- a horizontal row of decision buttons in stable order: Approve, Rewrite softer, Remove link, Delay 24h, Convert to comment, Save to backlog, Pause, Duplicate next week, Reject.

"Approve all low-risk" is a single bulk action. "Redistribute schedule" runs the placement engine. The page never auto-approves anything.

## Scheduler

The scheduler shows the same items grouped by day (default), account, or product. The cadence load strip per platform makes the week&apos;s shape visible at a glance. A backlog rail surfaces held items so restoring is a single click.

When the placement engine moves an item, the move panel lists the reason with the platform-native rationale ("LinkedIn audience is most active mid-week", "Account cooldown applied", etc.).

## Comments and discussions

Two surfaces, intentionally distinct:

- **`/discussions`** — every evaluated thread with participate / watch / **skip** recommendation. The page deliberately surfaces "skip" with its reason, since most threads are not worth participating in.
- **`/comments`** — calm comment and reply drafts gated by the conversation risk layer. Drafts only exist for non-skipped threads with matched insights.

## Platform command centers

One overview + four platform surfaces:

- **Reddit** — comments-first ratio panel.
- **X** — format mix + per-account velocity.
- **LinkedIn** — polish checklist.
- **Google** — search visibility, content freshness, discoverability signals, YouTube planning. Not a publishing surface.

Each command center renders the same shared building blocks (`StrategyHeader`, `PlatformStats`, `RecommendationsCallout`, `AccountsForPlatform`, `ContentQueueForPlatform`, `PlaybookGrid`, `RiskRulesList`, `ContentFormatsList`, `OpportunitiesList`, `AnalyticsPlaceholder`, `OAuthFutureCard`).

## Discoverability dashboard

`/discoverability` is the cross-channel lens. It surfaces:

- search-to-social opportunities,
- social-to-search opportunities,
- topic cluster gaps,
- evergreen distribution,
- refresh windows,
- visibility-by-product ranking.

The dashboard never claims engagement numbers it does not have. The WebmasterID block clearly says "Data not yet connected" until that integration ships.

## Tone

- "Recommended cooldown" not "you must wait."
- "Move to backlog" not "skip."
- "Soften the CTA" not "fix this."
- "Skip this thread" not "ignore."
- "Data not yet connected" not "—" or "0."

## Mobile

The desktop sidebar is hidden under `lg:`. A bottom `MobileNav` exposes the five most-used operations. Tables scroll horizontally inside their cards rather than collapsing. Dense grids degrade to single columns.

## What operational UX never does

- It never paginates a queue into separate "alerts" and "items."
- It never adds urgency markers ("urgent", "act now", "expiring").
- It never gamifies review (streak counters, badges, "weekly score").
- It never auto-applies a risk fix without a calm explanation and a way to revert.
- It never fabricates an engagement metric to fill a placeholder.
