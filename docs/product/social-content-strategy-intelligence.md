# Social Content Strategy Intelligence

Status: current as of the `feat/social-content-strategy-intelligence` milestone.
Baseline audited: `origin/main` @ `2a64feb` (PR #176 merged).
Production inspected read-only: **2026-08-19T20:51Z**.

This layer answers *"what should I post next?"* — and it is **advisory only**.
Nothing in it can block, gate, delay, rewrite, reschedule or refuse a
publication. The operator decides; Signal advises.

---

## 1. The four categories, never collapsed

Every output carries exactly one of these labels, and they are not
interchangeable:

| Category | Definition | Example |
|---|---|---|
| **FACT** | Directly measured or read from a record | "You have published 15 posts to X." |
| **OBSERVATION** | Deterministically derived from facts | "0 of your last 28 posts open with a question." |
| **SUGGESTION** | Advisory interpretation of observations | "Consider testing a question-led opening." |
| **EXPERIMENT** | A suggestion whose purpose is to produce evidence | "Publish two question-led posts and compare 24h replies." |
| **AI INTERPRETATION** | Optional natural-language synthesis over the above | "Your feed reads as a single voice; varying the opening may help." |

An AI interpretation may never be the sole source of a fact or an
observation. If the model is unavailable, everything above it still works.

## 2. The architecture, and what it must never become

```
data → deterministic observations → recommendations → optional AI → operator decision
```

Not:

```
data → AI decision → enforcement
```

**Enforcement boundary.** `src/core/strategy/` imports nothing from the
publishing, approval, scheduling or authorization paths, and nothing in
those paths imports from it. An invariant test asserts both directions.
A strategy module cannot become a precondition for publishing because it
cannot be reached from the code that publishes.

---

## 3. Phase 0 findings that shaped the design

### 3.1 There is no performance data at all

`post_metrics` = **0 rows**. `account_snapshots` = **0 rows**.
`metrics_refresh_runs` = **0 rows** (the table exists; the cron has not
fired since the merge). So on the day this ships, every
performance-aware path returns `insufficient_data`.

That is the design constraint, not a blocker. The product must be useful
with **zero** performance data, which is what §7 below is about.

### 3.2 The corpus is real and has strong structure

61 published posts. Profiled directly from production:

| Platform | Posts | Avg chars | Avg words | Questions | Hashtags | Mentions | In-body URLs |
|---|---|---|---|---|---|---|---|
| x | 15 | 191 | 29 | 4 | **0** | **0** | **0** |
| bluesky | 13 | 230 | 34 | 3 | **0** | **0** | **0** |
| telegram | 17 | 344 | 53 | 3 | **0** | **0** | **0** |
| devto | 16 | 2925 | 448 | 6 | **0** | **0** | **0** |

Structural profile over the 28 X + Bluesky posts:

| Pattern | Count |
|---|---|
| Opens with a question | **0 / 28** |
| Contains any question | 7 / 28 |
| Question in the **last** line | **1 / 28** |
| Contrarian "X is not Y" opening | 7 / 28 |
| Second person (you / your) | 3 / 28 |
| Names the product | 4 / 28 |
| Closes with an aphorism | 13 / 28 |
| Any call to action | **0 / 28** |

These are the observations that make the product useful at n=0
performance. "You have never opened a post with a question" is a fact,
not a guess, and it supports an honest experiment suggestion without any
performance claim whatsoever.

Length varies 15× across platforms, so **length is only ever compared
within a platform**.

### 3.3 The existing topic classifier is not an archetype signal

`classifyTopic` was run over the 28 real short-form posts:

```
26  operational_observation
 1  architecture_deep_dive
 1  discussion_question
```

`operational_observation` is the function's **default when no signature
scores at all** (`topic-matrix.ts:391`). So it is silent on 93% of this
corpus, not classifying it. Its keyword signatures were tuned for
platform-affinity warnings on engineering and promo content, which this
operator does not write.

**Decision:** reuse `classifyTopic` for what it genuinely detects
(promotional, launch, engineering, discussion), and build the archetype
spine on **structural** signals instead — which the profile above shows
are present and discriminating. When nothing matches, the archetype is
`unknown`. Silently defaulting to a confident label is the specific
failure this milestone forbids.

### 3.4 What already exists and is reused as-is

| Module | Reuse |
|---|---|
| `intelligence/similarity.ts` | **Reused.** One canonical Jaccard, k=2 message / k=5 verbatim. No fourth engine. |
| `intelligence/repetition.ts` | **Reused.** `openingHook`, `closingCta`, `paragraphShape`, `rhythmSimilarity`. |
| `intelligence/statistics.ts` | **Reused.** The sample gates are the claim-safety spine. |
| `intelligence/cadence.ts` | **Reused** for inactivity and burst observations. |
| `metrics/metric-availability.ts` | **Reused.** Bluesky impressions stay unavailable. |
| `metrics/freshness.ts`, `age-windows.ts` | **Reused** for staleness and age-normalized comparison. |
| `metrics/account-context.ts` | **Reused** for audience-size gating. |
| `publishing-qa/topic-matrix.ts` | **Reused, extended additively** with an evidence-returning wrapper. `classifyTopic` itself is untouched. |
| `intelligence/reconciliation.ts` | **Revived.** It had zero production callers; its `compareGroups` path is the correct performance comparator. |

### 3.5 Dead ends found, and deliberately not used

- `qaDraft` — dead (re-export plus tests only).
- `detectCrossPlatformCopypaste` — **partially wired**: reachable through
  `assemblePlatformNativeDraft`, but its only production caller
  (`generate-draft.ts:246`) never passes `siblingDrafts`, so it has never
  executed. Its hook/CTA/rhythm ideas are sound; the strategy layer calls
  the primitives directly rather than routing through a path that has
  never run.
- `adapt-idea-for-platform.ts:239` hard-codes
  `const topicKind: TopicKind = "operator_lesson"`, so platform
  adaptation never actually classifies anything.
- `weekly_plan_items.cta` is **dead storage** — all seven `createPlanItem`
  call sites omit it, so it is null on all 86 rows. CTA must be derived
  from body text.

### 3.6 Corpus fields: what exists and what does not

`publish_history` holds **no text**, only `title_hash` / `body_hash`. The
text is one hop away in `execution_items.body`.

**Not available anywhere:** hashtags, mentions, per-post language,
cross-platform sibling linkage. Siblings must be *inferred* from
(different platform, near-in-time, similar text) — which is exactly what
`analyzeRepetition` already does.

**`mode` is not a reliable manual/API discriminator.** Six operator-
initiated write sites pass no `mode` and land as `'api'` via the
repository default. The strategy layer therefore treats `mode` as a weak
hint and never presents it as ground truth.

### 3.7 Three defects found in the previous milestones' own code

Confirmed by execution, not by reading:

1. `compareGroups([])` returns `verdict: "verdict_permitted"` — the
   strongest verdict, from no data at all. Both branches of the
   `verdicts.includes(...)` check are false for an empty array.
2. `messageSimilarity("", "")` returns **1.0**. `tokenize("")` → `[]`,
   `shingles([], k)` → `Set([""])`, and two identical singleton sets are
   100% similar. Two posts with null bodies on different platforms
   produce a `cross_platform_copy` finding at severity `high` claiming
   100% similarity.
3. `load-account-health.server.ts` does not filter `snapshot:` rows out
   of its `account_snapshots` read, so a history row can surface as the
   current account context.

All three are fixed in this milestone because the strategy layer depends
on all three paths.

---

## 4. The canonical feature model

One deterministic extraction layer, `ContentStrategyFeatures`. Every
field is nullable and **unknown stays unknown** — a field is never
populated to satisfy a type.

Fields fall into three confidence classes:

- **measured** — read directly from a record (platform, publishedAt, bodyLength)
- **derived** — computed deterministically from the text (hookType, ctaType)
- **inferred** — a judgement with evidence attached (archetype, topicCluster)

Derived and inferred fields carry the evidence that produced them, so
every classification can answer "why".

## 5. Classification with evidence

Every classifier returns `{ value, confidence, evidence[] }`, never a
bare label. `confidence` is one of `strong | moderate | weak | none`, and
`none` accompanies `unknown`.

A classification with weak evidence is reported as weak. The system does
not round up.

## 6. Cross-platform differentiation

Reuses the calibrated thresholds from the previous milestone: word-bigram
Jaccard, warn at 0.12, high at 0.30, verbatim at 0.45 — calibrated
against a measured within-platform maximum of 7.8% and a cross-platform
maximum of 83%.

**Extended this milestone:** the corpus shows the same message reaching
Telegram as well as X and Bluesky, so differentiation is computed across
every platform pair rather than X↔Bluesky only.

**At no similarity level is anything blocked.** 100% identical copy
remains publishable.

## 7. Graceful degradation — the heart of this milestone

Recommendation strength degrades with evidence; it does not disappear.

| Evidence available | What Signal says |
|---|---|
| Nothing published | "Try several different content types so Signal can learn what your audience responds to." |
| Posts, no performance data | "0 of your last 28 posts open with a question. Consider testing one." *(observation + suggestion, no performance claim)* |
| Posts, small performance sample | "Among 4 question-led posts, replies were higher than your recent baseline. The sample is small." |
| Posts, adequate sample | "Question-led posts have a higher 24h median reply count across 14 comparable posts." |

`insufficient_data` means **"no statistical performance claim"**. It never
means "no recommendation".

## 8. Exploration vs exploitation

Every recommendation set contains at least one **explore** option
whenever an untested dimension exists. Without that rule the engine
becomes a self-reinforcing loop that recommends whatever happened to win
in a sample of four.

With this corpus, the untested dimensions are abundant and real: no
question openings, no CTAs, no links, no hashtags, one topic.

## 9. Claim safety

Reuses `containsCausalClaim` from the statistics module and extends its
pattern set for strategy-specific overclaims ("increases reach by",
"the algorithm prefers", "posting at 14:00 will"). An invariant test
scans every emitted string.

Permitted: *"in this sample"*, *"consider testing"*, *"has not been
tested"*, *"data is limited"*.
Forbidden: any statement that a format, time or platform behaviour
*causes* a performance outcome.

---

# Part II — Operating the strategy layer

Written for whoever runs Signal, not for whoever built it.

## 10. Where it appears

| Surface | What it shows | What it can do |
|---|---|---|
| `/strategy` | the whole picture: mix, options, performance evidence, cross-platform pairs, experiments, optional AI reading | nothing — it is a page of text |
| Weekly plan | the top two options as a strip | nothing; it never gates the plan |
| Compose sheet | the same strip beside the editor | nothing; the editor behaves identically without it |
| MCP | five read tools under `signal.strategy.*` | read only, workspace-scoped |

There is no sixth surface, and no background job. The strategy layer runs
when a page is rendered or a tool is called, and never on a schedule.

## 11. Reading a recommendation

Every option carries four things, and the fourth is the one to read
first:

1. **A title** — the option, in the operator's words.
2. **A rationale** — one sentence on why it appeared.
3. **Evidence** — each item labelled FACT, OBSERVATION or SUGGESTION,
   with the table or computation it came from.
4. **An evidence strength** — *Directly measured*, *Moderate evidence*,
   *Weak evidence*, or *No performance data*.

That last label describes the **evidence**, not the advice. "No
performance data" does not mean the option is bad; it means Signal is
telling you it has measured nothing, which is currently true of every
workspace whose `post_metrics` table is empty.

## 12. What the numbers will and will not do

- A median needs **6** measured posts. Below that, no median is shown for
  any dimension — not a zero, not an estimate.
- A comparative verdict needs **25**. Between 6 and 25 the wording says
  "in a small sample" and means it.
- Posts that were never measured are **excluded** from every sample.
  They are never counted as zero engagement, because "we did not read it"
  and "nobody engaged" are different facts.
- Percentages appear only once there are **10** posts. Below that the mix
  is reported as counts, because "40% product updates" from five posts is
  two posts wearing a decimal point.

## 13. Experiments

An experiment is a question plus the arithmetic of answering it. Signal
computes how many posts each arm still needs and, from your actual
publishing rate, how many weeks that is. When the answer is longer than
six months it says so plainly rather than leaving you to work it out.

Nothing enforces an experiment. There is no arm assignment, no post is
rejected for being "outside" one, and abandoning an experiment costs
nothing.

## 14. The AI section

Optional in the strictest sense: with no provider configured, the page is
complete and unchanged. When a provider is configured, the model receives
the evidence that is already on the page and is asked to restate it.

Its output is discarded outright if it contains a number that is not in
that evidence, a causal claim, an overclaim, or an instruction. The page
then shows a short note saying so. That note is not an error — it is the
guard working, and everything above it was computed without any model.

## 15. Turning it off

- **AI only**: unset `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, or set
  `SIGNAL_AI_PROVIDER` to a provider with no key. The rest is unaffected.
- **The advisory strips**: remove `<StrategyHints …>` from
  `weekly-plan/page.tsx` and `founder-compose-sheet.tsx`. Nothing else
  reads them.
- **The whole layer**: remove the `/strategy` entry from
  `route-manifest.ts` and `sidebar.tsx`, and the five `signal.strategy.*`
  entries from `tool-registry.ts`. No publishing, approval or scheduling
  code imports `@/core/strategy`, and an invariant test keeps it that way,
  so nothing downstream breaks.

## 16. What it deliberately cannot tell you

- **Why** a post did well. Signal has no access to how a platform treated
  your account, and does not guess.
- **The best time to post.** That would need many measured posts per time
  slot; with none, any answer would be invented.
- **How you compare to anyone else.** There is no benchmark data in
  Signal, and a model asked for one would make it up.
- **Whether a similarity level is too high.** Reposting the same message
  everywhere is a valid choice. The percentage is a measurement, not a
  verdict, and it never stops a post.
