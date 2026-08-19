# Provider metric capabilities — what X and Bluesky actually expose

Status: current as of the `feat/social-trust-performance-intelligence` milestone.
Baseline audited: `origin/main` @ `861fb05` (working tree `1311bc2`).
Provider documentation checked: **2026-08-19**.

This is the authoritative record of what post-performance data Signal can read
per platform. It exists because the previous answer lived in a code comment
(`src/core/metrics/metrics-provider.ts`) and was wrong, and because the two
documents that discussed provider access — `docs/live-platform-verification.md`
and `docs/oauth/x-oauth.md` — were both stale in ways that blocked a feature.

**Rule for this document:** every capability claim cites the provider's own
documentation. No third-party blog is a source of truth. Where a page could not
be loaded, the claim is marked `NOT VERIFIED` rather than filled in from
recollection.

---

## 1. The correction

Until this milestone, Signal's code asserted:

```ts
// src/core/metrics/metrics-provider.ts (before this milestone)
x: "unavailable",
// "X metrics require an elevated/paid API tier this account doesn't have."
```

That is obsolete. As of February 2026 the X API self-serve model is
**pay-per-usage credits**, not Free/Basic/Pro subscriptions, and post metrics —
including impressions — are readable with the scopes Signal already holds.

Source: `docs.x.com/x-api/getting-started/pricing` — "The X API uses
pay-per-usage pricing. No subscriptions—pay only for what you use."
Changelog, 6 Feb 2026 — "we officially launched X API Pay-Per-Use pricing… Basic
and Pro plans remain available, and existing subscribers can opt in to
Pay-Per-Use."

The practical floor for reading X metrics is now **cost, not capability**.

---

## 2. X — what is readable

Scopes already granted on all three connected X identities
(`platform_connections.scopes`): `users.read`, `tweet.read`, `offline.access`,
plus the SAFE_TEST_MODE-gated `tweet.write`, `media.write`.

**No reauthorization is required for anything in this document.**

| Data | Endpoint | Auth | Availability |
|---|---|---|---|
| Own recent posts | `GET /2/users/{id}/tweets` | `tweet.read` + `users.read` | yes |
| `like_count`, `reply_count`, `retweet_count`, `quote_count`, **`bookmark_count`, `impression_count`** | `post.fields=public_metrics` | bearer token | yes |
| `url_link_clicks`, `user_profile_clicks` | `non_public_metrics` | user context, owned post | **≤30 days from post creation** |
| Organic-context impressions | `organic_metrics` | user context, owned post | **≤30 days from post creation** |
| Follower / following counts | `user.fields=public_metrics` | bearer token | yes |
| Mentions | `GET /2/users/{id}/mentions` | `tweet.read` + `users.read` | yes |
| Who replied | `/2/tweets/search/recent` | — | last 7 days only |
| Account-level historical reach | — | — | **does not exist** |

The decisive fact: `impression_count` is in **`public_metrics`**, not in the
30-day-limited `non_public_metrics`. Source:
`docs.x.com/x-api/fundamentals/metrics`.

Two consequences that shape the implementation:

- **You cannot request a sub-field.** "When you request public_metrics, you get
  all metrics (likes, reposts, replies, quotes, bookmarks, impressions). You
  can't request just public_metrics.like_count." Requesting one counter bills a
  full Post resource read.
- **The 30-day window is unrecoverable.** Link clicks and profile clicks for
  posts older than 30 days are gone permanently. Signal must store
  `unavailable`, never `0`.

### Not designed against

`GET /2/tweets/analytics` exists with ~23 metrics and hourly granularity, but
`docs.x.com/x-api/overview` lists Analytics under the Enterprise-only section
and the pay-per-use pricing page never mentions it. Treated as Enterprise-gated.
Nothing in this milestone depends on it.

### Cost and rate limits

- **Owned Reads** — "requests made by your own developer app for your own data"
  — **$0.001 per resource**. `GET /2/users/{id}/tweets` and `/mentions` qualify.
  Standard Post reads are $0.005.
- **24-hour billing deduplication** — "If the same post is returned from
  multiple queries within a day, it only counts once for billing." This makes
  intra-day snapshotting of a fixed post set nearly free.
  **Inference boundary:** the docs say this about *billing*. They say nothing
  about whether a second same-day fetch returns fresher values. Do not assume
  it does.
- Pay-per-usage is capped at 3 million Post reads per billing cycle.
- Rate limits are **no longer tiered**: `GET /2/users/:id/tweets` is 900 per
  15 min per user. "Rate limits and billing are separate" — they are two
  independent budgets.

`NOT VERIFIED`: the legacy Free / Basic / Pro dollar figures and quotas.
`developer.x.com` returned HTTP 402 on every page attempted, so those numbers
are deliberately absent here rather than quoted from memory.

---

## 3. Bluesky — what is readable

Auth model: app password → `com.atproto.server.createSession`. For metrics this
is irrelevant — every engagement read this milestone needs works against the
**unauthenticated public AppView** at `public.api.bsky.app`, which "does not
support authentication" at all.

| Data | Endpoint | Auth | Availability |
|---|---|---|---|
| `likeCount`, `repostCount`, `replyCount`, `quoteCount`, **`bookmarkCount`** | `app.bsky.feed.getPosts` | none | yes |
| Own post list | `app.bsky.feed.getAuthorFeed` | none | yes, cursor-paginated |
| Followers / following / post count | `app.bsky.actor.getProfile` | none | yes |
| Reply threads on our posts | `app.bsky.feed.getPostThread` | none | yes |
| Who liked / reposted / quoted | `getLikes` / `getRepostedBy` / `getQuotes` | none | yes |
| Notifications / mention inbox | `app.bsky.notification.listNotifications` | **Bearer required** | yes, authenticated only |
| **Impressions / views / reach** | — | — | **does not exist** |

### The impressions invariant

**Bluesky exposes no impressions, views, or reach metric.** This is not
tier-gating and not an auth restriction — the field does not exist.

Established two ways:

1. Every `properties` key in Bluesky's official OpenAPI document (883 KB,
   152 paths) was enumerated and matched against
   `view|impress|reach|seen|analytic|metric|insight|stat`. The only engagement
   counters anywhere are the five above.
2. A live read of Signal's own published posts returned exactly:
   `author, bookmarkCount, cid, embed, indexedAt, labels, likeCount,
   quoteCount, record, replyCount, repostCount, uri`.

`app.bsky.feed.sendInteractions` carries an `interactionSeen` concept, but it is
**write-only telemetry sent to a third-party feed generator** with no read
counterpart.

This invariant is enforced by test. See §6.

### Rate limits

- PDS: **3,000 requests per 5 minutes, keyed on IP** — shared across tenants on
  serverless egress. Another reason to prefer the unauthenticated AppView.
- `createSession`: 30 per 5 min and 300 per day **per account**. Persist and
  reuse sessions; never log in per invocation.
- Public AppView: no numeric limit published — "These API services have generous
  rate-limits."
- Cost: none, at any volume.

---

## 4. Neither provider stores history

X defines every metrics object as values "at the time of the request".
Bluesky has no time-series endpoint among its 152 paths.

**Any trend line must be built from Signal's own snapshots.** This is the single
most important architectural constraint in the milestone, and it is why
`post_metrics` carries hour-bucketed `snapshot:<source>:<hour>` rows rather than
only a latest-value cache.

---

## 5. The capability model in code

`src/core/metrics/metrics-provider.ts` remains the single source of truth for
"can we show verified metrics for this platform, and in what shape?". This
document explains *why* each entry has its value; the code is what the product
reads.

| Platform | Capability | Why |
|---|---|---|
| `bluesky` | `verified` | public AppView, no auth, five counters |
| `x` | `verified` *(changed in this milestone)* | `public_metrics` incl. impressions, scopes already granted |
| `reddit` | `verified` | public permalink `.json` |
| `devto` | `verified` | public `articles/{id}` |
| `hashnode` | `unavailable` | analytics behind a GraphQL query not integrated |
| `linkedin` | `unavailable` | post analytics require approved Marketing API access |
| `telegram` | `unsupported` | Bot API exposes no view/reaction counts |
| `threads`, `instagram`, `youtube` | `unsupported` | no publisher and no metrics read |

Per-metric availability is finer-grained than per-platform capability — X has
impressions and Bluesky does not, though both are `verified`. That is carried by
`metricAvailability()` in the same module, not by the platform capability alone.

---

## 6. Invariants this milestone pins by test

- A missing provider metric is `unavailable`, **never** `0`. Specifically:
  Bluesky impressions must never render or persist as a zero.
- X capability must remain `verified`; a regression to `unavailable` fails.
- Metrics whose provider window has expired store `unavailable` with
  provenance, not a fabricated value.
- Stale cached metrics must not be presented as fresh.

See `src/core/metrics/*.test.ts` and `src/test/`.

---

## 7. Documents corrected by this milestone

- `docs/live-platform-verification.md` — stamped F5.1, last touched
  2026-05-23. Records every platform as **Verified? No** and states "Signal does
  NOT use the X API". Real X API publishing landed five days later (`7bdcd88`,
  `4dec19c`, 2026-05-28) and production `publish_history` holds 15 successful X
  publications. A staleness banner now points here.
- `docs/oauth/x-oauth.md` — asserted "The Free tier blocks several read
  endpoints" while also stating publishing scopes are not requested. Both were
  false. Corrected.

## 8. Known stale, deliberately NOT fixed here

- `docs/platforms/platform-capability-matrix.md` opens with "Today, none of
  these are wired" and lists X "Read metrics" as `future — Depends on API access
  tier`. The document describes an older capability model that predates
  `platform-capabilities.ts` as it now stands; rewriting it is out of scope for
  this milestone and would obscure the diff.
- `src/core/platform-oauth/safety-checks.ts` flags `tweet.write` / `media.write`
  in `oauth-provider.ts` unconditionally, which the current config legitimately
  contains. Pre-existing; untouched here.

## 9. Two checks only an operator can perform

1. **Vercel cron + env for `/api/metrics/refresh`.** The route is deployed and
   the cron secret is configured (an unauthenticated GET returns 401, not 503 —
   see `src/lib/cron-auth.ts` for why that distinction is proof). Confirm the
   cron is firing and that `SUPABASE_SERVICE_ROLE_KEY` exists in the Signal
   Production environment; unset makes the route 503 *after* auth, invisible
   from outside.
2. **X developer project billing.** Confirm the project is on pay-per-use with
   credits available at `console.x.com`. Everything in §2 comes from
   `docs.x.com`; the account's actual plan is not readable from the codebase.

Do not paste secret values into the repo or into an issue. The sweep
observability added in this milestone is designed so the next production run
explains itself without exposing configuration.
