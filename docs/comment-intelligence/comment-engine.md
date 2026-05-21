# Comment intelligence engine

Comments are participation. They're how an account warms up, how a founder gets trust, and how Signal builds discoverability without leaning on outbound links. The comment engine treats them seriously.

## Philosophy

- Comments matter more than posting volume.
- The best growth move is often non-participation.
- Generic agreement, executive clichés, and engagement bait are worse than silence.

## Pipeline

```
DiscussionOpportunity (mocked / seeded)
       │
       ▼  evaluateDiscussion(opportunity, insights, products)
       │
       ▼
DiscussionOpportunity {
  matchedInsightIds,
  communityFit,
  participation,
  participationScore,
  recommendation,    // participate | watch | skip
  skipReason
}
       │
       ├─ Reddit:    buildCommentDrafts → CommentDraft[]
       ├─ LinkedIn:  buildCommentDrafts → CommentDraft[]
       └─ X:         buildReplyDrafts   → ReplyDraft[]
```

Every draft is scored by the conversation risk layer ([conversation-risk-layer.md](./conversation-risk-layer.md)).

## Discussion evaluation

`evaluateDiscussion` walks the inputs and produces:

- **matchedInsightIds** — only insights whose product is matched by the discussion seed, narrowed further by tag overlap.
- **communityFit** — `strong` / `medium` / `weak` / `off_topic`. Off-topic threads short-circuit to `skip`.
- **participation** — `freshness` (active/settling/cold), `audienceMatch` (aligned/adjacent/off), `noise` (low/medium/high).
- **participationScore** — 0–100 composite, used for the participate/watch/skip decision.

Skip logic is deliberately stricter than participate logic. A thread without matched insights always returns `skip` — Signal does not reach for participation it didn't earn.

## Per-platform drafts

### Reddit

Two calm comment drafts per matched insight:

- Lead with a specific operator observation, not the insight verbatim.
- Close with an acknowledgment scaled to community fit.
- No links, no CTAs.

### LinkedIn

Two moderate comment drafts per matched insight:

- Acknowledge the original post, add one nuance.
- Mention "how it played out for us" in a single sentence.
- No CTAs, never "Great post!" or "+1".

### X

Two short reply drafts per matched insight:

- One sentence on substance plus a tail sentence calibrated to thread freshness.
- No links.
- No engagement bait.

## Skip decisions

Signal explicitly recommends skipping when:

- the community fit is `off_topic`,
- no insight matches the discussion topic,
- the thread has cooled and the angle is stale,
- noise is high and participation score is under threshold.

The skip reason is rendered next to the recommendation so the founder can see the engine's logic.

## What this layer never does

- It does not auto-publish comments.
- It does not write replies without a matched insight.
- It does not produce more than two drafts per thread.
- It does not invent a customer story.
- It does not mention competitors by name.
