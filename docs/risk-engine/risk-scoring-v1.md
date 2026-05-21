# Risk scoring v1

Risk scoring is the deterministic input the rest of Signal trusts. Same plan + same accounts + same products = same scores. No model calls, no randomness.

The implementation lives in `src/core/risk/`.

## Output shape

```ts
interface RiskScore {
  score: number;        // 0–100, clamped
  level: "low" | "medium" | "high" | "blocked";
  reasons: string[];    // human-readable, surfaced in the UI
  recommendation: string;
}
```

## Inputs (per item)

| Input | Signal |
|---|---|
| Outbound link present | +12 to score; counted toward link saturation. |
| CTA present | If product CTA policy is `no_cta`, +30. |
| Promotional phrasing | Whitelisted phrases in `policies.ts`; +10 each. |
| Comparative phrasing | Whitelisted competitor-comparison phrases; +12 each. |
| Duplicate hooks | Same hook found in another scheduled item: +25. |
| Domain repetition | Same product + outbound link repeated on the same account: +8 per repeat. |
| Direct-link saturation | Two or more promo items on the same account this week: +18. |
| Platform overload | Over suggested cadence: +14. Approaching max: +8. |
| Account overload | 3+ items this account this week: +8 plus +4 per additional. |
| Same-day repetition | Account has another item the same day: +22. |
| Cooldown conflict | Less than platform-minimum hours from nearest item: +18. |
| Synchronized posting | Different account within 15 minutes: +10. |
| Account status | `planned` / `setup_needed` / `awaiting_manual_creation`: +60 and forces `blocked`. |
| Warming account | +12 plus a soft recommendation. |
| Product risk tolerance | Conservative: ×1.15. Assertive: ×0.9. |

## Thresholds

```
low      0 – 24
medium  25 – 54
high    55 – 79
blocked 80 – 100 (or any account-blocked condition)
```

Thresholds live in `policies.ts`.

## Recommendations

Recommendations are calm and concrete:

- Blocked: *"Hold publishing. Move to the backlog or re-plan for next week."*
- High: *"Recommended cooldown: 3 days. {first reason}."*
- Medium: *"Soften tone or delay 24h. {first reason}."*
- Low: *"Safe to publish on schedule."*

## When scoring runs

Scoring runs on every state mutation. The store reducer calls `scoreAllItems` after approve, reject, delay, save-to-backlog, restore, redistribute, and the bulk low-risk approval. This guarantees the UI's risk badges, recommendations, and reason lists stay current.

## Determinism

The scorer is a pure function of:

- The item.
- The account's status and product.
- The other items in the same week.

No clocks, no random IDs, no async. Two runs of the scorer on the same input return the same score.
