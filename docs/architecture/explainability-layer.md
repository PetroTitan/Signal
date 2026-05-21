# Explainability layer

Every Signal engine — scheduler, risk, approval, content intelligence, comment intelligence, discoverability — already produces a reason string. The explainability layer is the small, shared UI primitive that renders those reasons calmly and consistently across the app.

## The primitive

```tsx
import { Explain } from "@/components/explain";

<Explain
  tone="info" | "warn" | "block" | "ok"
  label="Why this risk"
  shortReason="Promotional saturation on this account this week."
  detailedReasons={[
    "Two link-bearing items already scheduled on @webmasterid.",
    "Reddit link tolerance is very low.",
  ]}
  recommendation="Soften this draft or move to the backlog."
  relatedEntity={{ label: "Account", value: "WebmasterID · X" }}
  link={{ href: "/risk-center", label: "Open risk center" }}
/>
```

## Named wrappers

For each common "why" question Signal answers, there is a thin wrapper that picks a sensible default tone and label:

| Wrapper | When to use |
|---|---|
| `WhyRiskBadge` | Inline next to a risk score. |
| `WhySkipped` | When a thread, draft, or opportunity is intentionally not surfaced. |
| `WhyBacklogged` | When an item moved aside. |
| `WhyScheduledHere` | When the scheduler picked a non-obvious slot. |
| `WhyOpportunity` | Inline next to an opportunity to explain its derivation. |
| `WhyAccountIneligible` | On the account detail page and weekly plan rows. |
| `WhyContentBlocked` | When a draft fails the guardrail layer. |
| `WhyDiscoverabilityOpportunity` | Inline on the Google command center and `/discoverability`. |

All wrappers ultimately render `Explain` so the visual language stays uniform.

## Tone palette

- `info` — neutral, signal-blue accent.
- `warn` — amber accent. Recommended cooldown or softening.
- `block` — red accent. Don't publish in this state.
- `ok` — emerald accent. All clear.

## Voice rules

- Lead with a short reason (one sentence, no hedging).
- Detailed reasons are concrete, not abstract.
- The recommendation is calm and reversible.
- No exclamation marks. No emojis. No "warning."
- "Skip this thread", "Move to backlog", "Recommended cooldown" — these are the canonical phrasings.

## Where this is rendered today

- Dashboard operational panels (`NextBestActions`, `ItemsNeedingJudgment`).
- Discussion cards (skip reason).
- Comment drafts (conversation risk reasons).
- Approval queue (risk reasons + recommendation).
- Risk center (per-item recommendation).
- Scheduler (recent moves panel).
- Backlog page (reason held).
- Google visibility (discoverability opportunity rows).

## Future evolution

When LLM-assisted explanations arrive, they replace the reason string — the primitive stays the same. There is no separate "AI explainability" surface; the existing `Explain` component is the only path.
