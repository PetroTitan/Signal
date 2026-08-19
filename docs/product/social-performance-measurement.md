# Social performance measurement — the operator model

Status: current as of the `feat/social-trust-performance-intelligence` milestone.
Baseline audited: `origin/main` @ `861fb05` (branched from `1311bc2`).

This document says what Signal can now measure, what it deliberately
refuses to say, and the two things only an operator can do.

Provider capability lives in
[../platforms/provider-metric-capabilities.md](../platforms/provider-metric-capabilities.md).
This file is about the product behaviour built on top of it.

---

## 1. The question this milestone was asked

*Does publishing through Signal's API correlate with declining reach on X
and Bluesky?*

**Signal cannot answer that, and this milestone does not pretend to.**
What it does instead is make the question answerable later, and answer
the smaller questions that today's data genuinely supports.

Three findings from the Phase 0 audit shape everything below:

- **The primary Bluesky identity has one follower.** Near-zero engagement
  on an account with no audience needs no algorithmic explanation.
- **28 measurable posts exist in total** (15 X, 13 Bluesky), and 8 of the
  12 readable ones sit at exactly zero engagement. Every statistical gate
  in the product fails at this size, by design.
- **The measurable problem is cross-platform copy reuse.** Word-bigram
  similarity between X and Bluesky pairs reaches 83%, published minutes
  apart, while the highest similarity between two posts on the *same*
  platform is 7.8%.

---

## 2. What Signal will now tell you

| Question | Where |
|---|---|
| What did we publish? | `/results`, `signal.social.recent_posts` |
| How old is a post, and when was it measured? | `post_metrics.provider_published_at`, `age_window`, `fetched_at` |
| What does this provider actually expose? | Account health → "What this platform reports" |
| How fresh are these numbers? | Account health → "Data freshness" |
| How large is the audience? | Account health → "Audience" |
| Are X and Bluesky posts too similar? | Account health → "Cross-platform similarity", `signal.social.repetition` |
| Are we posting too often, or not at all? | Account health → "Posting cadence" / "Recent activity" |
| Is recent performance measurable? | Account health → "Recent performance" |
| Is there enough data for a conclusion? | Every comparison carries its own verdict |
| What should I do next? | Account health → "What to do next" |

When the evidence is insufficient, the correct answer is **"we don't have
enough data yet"**, and that is a successful result rather than a gap.

---

## 3. What Signal will never tell you

- That a platform penalised, suppressed, throttled or shadowbanned an
  account. No provider exposes that; asserting it would be invented.
- That API publishing *caused* a performance difference. The comparison
  is observational, from one account, with operator-chosen exposure.
- A composite "trust score". Signals of different confidence are not
  averaged into one number.
- A metric a provider does not report, rendered as `0`.
- A median below six measured posts, or quartiles below thirteen, or any
  verdict below twenty-five per group.

`containsCausalClaim()` is the machine-readable form of this section, and
an invariant test scans the subsystem's string literals against it.

---

## 4. The sample-size contract

| Sample | What is permitted |
|---|---|
| n < 6 | `insufficient_data`. No median is computed or shown. |
| 6 ≤ n < 13 | Median, with the sample size and a warning. No quartiles. |
| 13 ≤ n < 25 | Median and quartiles, descriptive only. No verdict. |
| n ≥ 25 per group | A comparative verdict, still with confounder warnings. |

A comparison takes its **weakest** arm's verdict. Everything is
rank-based: social engagement is heavy-tailed, so for the exponents
typical of this data the variance is not a defined quantity and a mean ±
SD would describe something that does not exist.

Trends additionally require both halves of the series to clear the median
gate, and a floor guard: when median engagement is below one interaction
in both halves, movement is reported as stable rather than as a trend,
because the difference is one like on one post.

---

## 5. Age normalization

Cumulative counts are not comparable across posts of different ages. Every
reading is bucketed:

| Window | Reading age |
|---|---|
| `1h` | 0–3 h |
| `6h` | 3–12 h |
| `24h` | 12–48 h |
| `72h` | 48–120 h |
| `7d` | 120–336 h |
| `older` | 336 h+ |

Two posts are comparable only inside the same window. A window with no
reading returns null — **never** an interpolated value, which would be a
fabricated provider number.

---

## 6. Measurement operations

### The nightly sweep

`/api/metrics/refresh`, Vercel cron at `0 6 * * *`. Enrols publications
from the last 14 days and re-reads connected rows on a 6-hour cooldown.
That window is correct for a cron and is exactly why older publications
were never measured.

Every run now emits a `SweepReport` answering: did it start and finish,
which workspaces were considered, how many candidates were found,
enrolled, attempted, skipped, rate-limited and failed, and which provider
failed. `report.diagnosis` states the first true cause in one sentence.
The report is returned in the response, logged as one JSON line, and
written to `activity_events` per workspace.

### The bounded backfill

`POST /api/metrics/backfill`. **Dry run by default** — without
`"execute": true` it returns the plan, the cost estimate and the spend
verdict and contacts no provider.

```jsonc
// Dry run: what would a full backfill cost?
{ "since": "2026-05-01T00:00:00Z" }

// Free platforms only, executed
{ "platforms": ["bluesky"], "execute": true }

// Paid run, with the spend explicitly authorised
{ "platforms": ["x"], "execute": true, "confirmedMaxUsd": 0.05 }
```

Rules: an explicit `[since, until)` range, `maxPosts` ceilinged at 500,
and — when the plan costs money — a `confirmedMaxUsd` at least as large
as the estimate. A platform with no documented cost rate blocks a live run
outright rather than guessing.

The estimate for the full real backfill is **$0.015** (15 X posts at
$0.001 owned-read pricing; Bluesky is free).

---

## 7. Publication method

`publish_history.mode` now has four values:

| Value | Meaning |
|---|---|
| `api` | Signal published it through a provider API |
| `manual` | A person published it and recorded it in Signal |
| `external` | Found on the provider; Signal never published it |
| `unknown` | Attribution genuinely undetermined — never a guess |

All 92 existing rows are `api` and none was rewritten.

**Nothing writes `external` yet, and that is deliberate.**
`publish_history.execution_item_id` is `NOT NULL`, so recording an
externally-published post would mean fabricating an `execution_item` that
never existed. Discovered posts live in the reconciliation report instead.
The value exists so a future writer with a legitimate execution item has
somewhere honest to put it, and so the vocabulary is available to the
read-side comparison today.

---

## 8. Two operator checks

These cannot be done from the codebase.

1. **Why the metrics cron never wrote a row.** The route is deployed and
   the shared secret is configured — an unauthenticated `GET` returns 401,
   not 503, and `src/lib/cron-auth.ts` is why that distinction is proof.
   Check the Vercel cron invocation log, and confirm
   `SUPABASE_SERVICE_ROLE_KEY` exists in the Signal Production
   environment; unset makes the route 503 *after* auth, invisible from
   outside. The sweep observability added here means the next run will
   explain itself.
2. **X developer project billing.** Confirm the project is on
   pay-per-use with credits available at `console.x.com`. Every capability
   claim in this milestone comes from `docs.x.com`; the account's actual
   plan is not readable from the codebase.

Do not paste secret values into the repo or an issue. Nothing in this
subsystem needs them to be shared to be diagnosed.

---

## 9. Known limitations

- **No X post has been measured yet.** The reader is built and tested, but
  it has never run against the live API from this branch. The first real
  run is an operator action.
- **The X reconciliation path needs a numeric user id** stored on the
  connection. Where `provider_account_id` is absent, own-timeline
  reconciliation reports that rather than guessing.
- **`account_snapshots` has no scheduled writer.** The readers exist and
  the table exists; wiring them into the sweep is deliberate follow-up
  work rather than something to bolt on unmeasured.
- **The 30-day X window has already closed** on almost the whole corpus.
  Link clicks and profile clicks for the May–June campaign are
  unrecoverable, and are stored as unavailable rather than zero.
- **Bluesky `getAuthorFeed` pagination depth is undocumented.** For
  accounts this size the full history is reachable; for a large account it
  may not be, and the reconciliation report says when it truncated.
- **The similarity thresholds are calibrated on one corpus.** 0.12 sits in
  the measured gap between 7.8% (highest within-platform) and 13.7%
  (lowest cross-platform pair worth flagging). A different account's
  writing may need a different bar; the constant is exported and
  documented rather than buried.

---

## 10. What is deliberately not built

No automated liking, following, unfollowing, replying, mention-sending,
simulated browsing, randomised human-looking delays, or account warm-up.
`NEVER_AUTOMATED` in `src/core/intelligence/recommendations.ts` writes
this down in code, every `Recommendation` carries `automatable: false`,
and a test asserts the recommendation UI renders no button or form that
could perform the action.

Signal may draft a reply for review. Sending it is the operator's.
