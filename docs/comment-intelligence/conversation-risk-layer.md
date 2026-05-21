# Conversation risk layer

`src/core/comment-intelligence/risk.ts` scores every comment or reply against deterministic risk signals before the draft reaches the comments page or the approval queue.

## Risk levels

- `low` — safe to participate as drafted.
- `medium` — reduce certainty, remove any CTA, reconsider phrasing.
- `high` — rewrite softer or wait before replying.
- `blocked` — skip this discussion; do not reply.

## Inputs scored

| Signal | Effect |
|---|---|
| Outbound link in a Reddit comment | +30 |
| Weak community fit | +25 |
| Repeated phrasing across recent comments | adds `repeated_wording` flag, +25 |
| Thread noise = high | +10 |
| Discussion engine recommends skip | +40 |
| Each content-guardrail flag | +18 |

## Blocking flags

The following guardrails immediately force the level to `blocked`, regardless of score:

- `cta_too_aggressive`
- `launch_language`
- `fake_certainty`

This is intentional. CTA-heavy or launchy comments on a community thread are platform-risk behavior; Signal doesn't queue them at all.

## Recommendations

Each level produces a single short recommendation surfaced under the draft:

- Blocked → "Skip this discussion. Don't reply."
- High → "Rewrite softer or wait."
- Medium → "Reduce certainty and remove any CTA."
- Low → "Safe to participate as drafted."

## Determinism

Same draft + same known-body history + same opportunity = same risk. The scorer has no clocks, no randomness, and no external calls.

## What this layer never does

- It does not auto-edit the draft.
- It does not retry generation against a different tone.
- It does not silence a draft from the UI — it always surfaces the risk and the recommendation.
- It does not block the founder from posting; it informs.
