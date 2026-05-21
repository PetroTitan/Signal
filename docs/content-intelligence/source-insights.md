# Source insights

Signal is insight-first, not output-first. Every piece of content the system suggests traces back to a `SourceInsight` — a founder observation, product lesson, support pattern, workflow problem, user problem, SEO opportunity, discoverability gap, industry pattern, operational lesson, or evergreen topic.

## Shape

```ts
interface SourceInsight {
  id: string;
  productId: string;
  title: string;
  coreInsight: string;
  summary: string;
  category: InsightCategory;
  sourceType: InsightCategory;
  audience: InsightAudience[];
  discoverabilityPotential: number;   // 0–100
  evergreenScore: number;             // 0–100
  conversationScore: number;          // 0–100
  freshnessPotential: number;         // 0–100
  riskLevel: "low" | "medium" | "high";
  platformFit: PlatformFit;
  createdAt: string;
}
```

`platformFit` carries a per-channel level (`strong`, `medium`, `weak`, `none`) for Reddit, X, LinkedIn, and Google. The opportunity engine reads these scores to decide how many platform-specific opportunities to produce per insight.

## Why insight-first

Two failure modes shape the model:

1. **Output-first AI tools** generate content from prompts. Signal does not. The founder's observations come first; the system's job is to translate them faithfully into each platform's voice.
2. **Posting-first dashboards** ask "what should I post today?". Signal asks "which insight is worth participating around this week, and on which platform?"

This keeps Signal from drifting into AI-spam territory. Insights are concrete, real, and owned by the founder.

## Category catalog

| Category | Use |
|---|---|
| `founder_observation` | Personal observations from running the company. |
| `product_lesson` | Lessons from the product itself — what it does, what it doesn't. |
| `support_pattern` | Recurring questions or fixes from customer support. |
| `workflow_problem` | Operational pain points discovered in daily work. |
| `user_problem` | Pain experienced by users that the product addresses. |
| `seo_opportunity` | Topic with strong search potential. |
| `discoverability_gap` | Topic where Signal's content isn't represented. |
| `industry_pattern` | Pattern observed across the industry, not just one company. |
| `operational_lesson` | A lesson about how to operate, not what to build. |
| `evergreen_topic` | A topic that holds value over time. |

## Where insights live

- `src/types/content-intelligence.ts` — type definitions.
- `src/lib/mock/source-insights.ts` — seed library, 11 insights across the six portfolio products.
- `src/core/content-intelligence/opportunities.ts` — `buildOpportunitiesForInsight(insight, product)` produces platform-specific opportunities.

## What Signal never does

- It does not generate insights from thin air.
- It does not paraphrase insights into multiple unrelated variations.
- It does not chain insights into clickbait threads.
- It does not score insights for "virality."

Insights exist because the founder observed them. Signal's job ends at faithful translation.
