# Platform adapters

Each platform adapter is a pure function that takes a `SourceInsight` + `ContentOpportunity` and returns deterministic `DraftVariant[]`. No external APIs, no LLM calls, no randomness.

## Files

```
src/core/platform-adapters/
  reddit.ts
  x.ts
  linkedin.ts
  google.ts       — produces DiscoverabilityOpportunity[], not drafts
  index.ts
```

## Reddit adapter

Reddit transforms insights into:

- `discussion_post` — open-ended discussion framed as a question to the subreddit.
- `question_post` — direct question with no link, no CTA.
- `founder_lesson` — first-person lesson, no link, no CTA.
- `soft_feedback_request` — request for input, contextual and never promotional.
- `helpful_comment` — short comment template, single insight, no link.

Reddit drafts intentionally:

- never include outbound links in the calm variants,
- never include CTAs,
- avoid product mentions in the hook,
- read like a community member, not a brand.

## X adapter

X transforms insights into:

- `short_post` — one-to-three sentences.
- `thread` — a 5–6 line numbered thread skeleton.
- `founder_observation` — short personal note.
- `build_in_public_update` — calibrated working note.
- `reply` — single-sentence reply template.

Hooks are shortened aggressively. Promotional variants are bounded by the product's allowed CTA copy (no improvised CTAs).

## LinkedIn adapter

LinkedIn transforms insights into:

- `authority_post` — long-form essay structure.
- `professional_insight` — industry-level take grounded in lived experience.
- `case_study` — customer or scenario story with concrete numbers.
- `thoughtful_comment` — calm, specific comment template.
- `founder_lesson` — narrative founder lesson.

LinkedIn drafts deliberately add structure (numbered observations, "what we measured / what we changed") to push back on weak credibility. The "no fake authority" guardrail still runs.

## Google adapter

Google does not produce social drafts. It produces `DiscoverabilityOpportunity` rows:

- `evergreen_distribution` — evergreen asset that maps to the insight but lacks amplification.
- `topic_cluster_gap` — strong discoverability potential with no asset in the cluster.
- `freshness_refresh` — insight aligns with an asset slipping out of the freshness window.
- `search_to_social` — asset ranks but has no social distribution.
- `internal_linking` — cluster lacks structural support for the insight.

These flow into the discoverability dashboard and the opportunities page.

## What every adapter shares

- Pure: same input, same output.
- Variants vary by `toneStrength` (calm / moderate / direct) and `ctaIntensity` (none / soft / contextual).
- Every draft is scanned by `scanText` (the content guardrail). Detected flags appear in the UI as small chips, not blocking errors.
- Adapters do not write to state. They are consumed by `buildDrafts(opportunity, insight, product, knownHooks)` and rendered as-is.
