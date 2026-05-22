# Demo data policy

Signal's mock data is intentionally small. The product is designed to render gracefully with 1–2 items per surface — density is not a feature.

## Why

A product that needs 50 fake rows to look credible loses credibility the moment a real user logs in with 2 rows. Signal's UI prefers honest sparseness.

## Volume targets

These are upper bounds, not lower bounds. The seed file should hold the minimum amount needed to exercise the engine paths once.

| Entity | Target | Rationale |
|---|---|---|
| Workspaces | 1 | Single founder use today. |
| Products | 6 | Real portfolio for the HELPERG founder. |
| Growth accounts | 4–5 | Believable handles only. One `planned` placeholder is allowed. |
| Weekly plan items | 2–4 | Enough to show approved + pending + risk variation. |
| Backlog items | 1 | One held item is enough. |
| Source insights | 4–6 | Enough to feed opportunities and discussions. |
| Discussion seeds | 2–4 | One participate, one watch or skip, one off-topic skip. |
| Content assets | 5–8 | Mix of freshness states. |
| Risk events | 2–3 | One medium, one low. |
| Activity events | derived from the above; do not add separate seed rows |

If a surface would feel empty with these limits, the empty state takes over (see [ui-realism-guidelines.md](./ui-realism-guidelines.md)).

## Believable identities only

No synthetic-looking handles:

- ❌ `u/wmi_observer`, `printerapps_help`, `PDF tools support`.
- ✅ `@webmasterid`, `@cashworkspace`, `petro-helperg`.

If an account does not exist on the platform yet, the seed places it in `planned` or `setup_needed` status with `handle: null` and `oauthConnected: false`. The UI shows "No connected account yet." — never a fake handle.

## No invented metrics

- No invented engagement counts.
- No invented impression numbers.
- No invented search positions outside the explicit `mockSearchPosition` field, which carries `null` when no estimate exists.
- No invented amplification counts above what is genuinely held in the seed.

When data isn't available, the UI says "Data not yet connected" or shows an empty state.

## What seed data is allowed to assert

- Founder-authored content: insights, draft hooks, draft bodies, CTAs that match a product's `allowedCtaCopy`.
- Operational state: `pending_approval`, `approved`, `backlog`, etc.
- Risk reasoning: every reason in `RiskScore.reasons` must be derivable from the data.
- Activity-event titles: derived from the existing data only; no standalone "fake events."

## What seed data may not assert

- A specific user count.
- A specific revenue number.
- A specific organic signup attribution.
- "Trusted by N companies" or similar claims.
- A platform engagement number (likes, comments, reposts).

## Maintaining the policy

When a new mock entity is added:

1. The smallest believable count goes in first.
2. If the surface looks empty, add a calm empty state — don't pad the seed.
3. Run through the affected pages mentally: would a real founder see this and feel like Signal is exaggerating?

If yes, cut.
