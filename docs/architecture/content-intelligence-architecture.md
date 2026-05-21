# Content intelligence architecture

Signal's content intelligence layer adds a deterministic, insight-first pipeline alongside the existing operational core. It does not replace the weekly planner, the approval engine, the scheduler, or the discoverability layer. It feeds them.

## Three layers, one direction of flow

```
Source insight  →  Platform opportunity  →  Draft variants
                ↘  Discussion opportunity →  Comment / reply drafts
                ↘  Discoverability opportunity  →  Refresh / topic-cluster recommendations
                                          │
                                          ▼
                              Approval queue + scheduler
```

Source insights come first; everything else is a translation.

## Module layout

```
src/types/
  content-intelligence.ts    — insights, opportunities, drafts, memory, guardrails
  comment-intelligence.ts    — discussion opportunities, comment + reply drafts, conversation risk

src/core/
  content-intelligence/
    guardrails.ts            — scanText + guardrailLabels (aggressive CTA, AI voice, etc.)
    opportunities.ts         — buildOpportunitiesForInsight (insight + product → ContentOpportunity[])
    drafts.ts                — buildDrafts (opportunity + insight + product → DraftVariant[])
    memory.ts                — buildMemoryRecords, summarizeMemory, recentlyUsedHooks
    index.ts
  platform-adapters/
    reddit.ts                — adaptToReddit
    x.ts                     — adaptToX
    linkedin.ts              — adaptToLinkedIn
    google.ts                — adaptToGoogle (produces DiscoverabilityOpportunity[])
    index.ts
  comment-intelligence/
    discussions.ts           — evaluateDiscussion
    comments.ts              — buildCommentDrafts, buildReplyDrafts
    risk.ts                  — scoreConversationRisk
    index.ts

src/lib/mock/
  source-insights.ts         — seed insight library
  discussions.ts             — seed discussion opportunities

src/app/(app)/
  content-intelligence/page.tsx
  opportunities/page.tsx
  discussions/page.tsx
  comments/page.tsx
```

## Why insight-first, not output-first

Output-first AI tools generate posts from prompts. Signal does not. The reason is operational, not philosophical: posts disconnected from a real observation rot fast, get caught by the risk engine, and erode the founder's voice.

The insight library is small on purpose. Eleven seed insights produce dozens of platform-specific opportunities and draft variants. Quality is bounded by the founder's observations, not by template diversity.

## Why comments matter more than posting volume

Comments build trust, warm accounts, and improve discoverability without leaning on outbound links. The comment engine is willing to recommend `skip` — most growth dashboards never do. Signal's threshold for `participate` is deliberately high.

## Why discoverability is separate from social posting

A search opportunity is not a post. The Google adapter produces `DiscoverabilityOpportunity` rows that flow into the discoverability dashboard and the cross-channel opportunities page — never into the social weekly plan. The split is the same one that made the platform command centers work.

## What is intentionally not automated yet

- No OpenAI / Anthropic / model calls in any adapter.
- No auto-publish, auto-comment, or auto-reply.
- No real-time crawling of subreddits, X threads, or LinkedIn posts. The discussion library is mock-seeded.
- No semantic memory. The memory layer is exact-match string accounting.
- No engagement metrics; analytics placeholders remain "Data not yet connected".

When real APIs ship:

- Insights can be sourced from CRM/support exports, but the type stays the same.
- Discussions can be seeded from platform search, but `evaluateDiscussion` stays the same.
- Draft generation can route through an LLM, but the guardrails and risk layer remain the gate.

The architecture intentionally keeps the operational core stable across all future integrations.
