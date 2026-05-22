# AI context pipeline

End-to-end shape of every AI call Signal will eventually make. The pipeline runs the same way for every use case; only the inputs and budgets change.

## The pipeline

```
retrieve  →  rank  →  compress  →  assemble  →  validate budget
                                                       ↓
                                               send to provider
                                                       ↓
                                               structured output
                                                       ↓
                                                  risk review
                                                       ↓
                                                human approval
```

No step is skipped. No autonomous loop wraps it.

## Step by step

### 1. Retrieve

`MemoryRetriever.retrieve(query)` (`src/core/memory/memory-retriever.ts`) returns a `MemoryRetrievalResult`. The query carries the `taskType`, the workspace, optionally a product/account/platform, and the `tokenBudget`.

The retriever:

- Filters out inactive entities.
- Optionally filters by `kinds`.
- Ranks by `scoreMemoryItem`.
- Caps by `maxItems` and `tokenBudget` and marks `truncated: true` if anything was dropped.

### 2. Rank

`rankMemoryItems` applies the relevance weights documented in [memory-architecture.md](./memory-architecture.md). Same-platform and same-product items rise to the top; risk and blocked-phrase items are eligible even at lower base relevance.

### 3. Compress

For historical learnings, `compressEventsToPatterns` (`src/core/memory/memory-compression.ts`) reduces raw events to compact `HistoricalPattern` objects with confidence and support count. The retriever never reads raw events; only compressed patterns.

### 4. Assemble

`assembleContext` (`src/core/memory/context-assembler.ts`) flattens the ranked memory into ordered layers: `system`, `workspace`, `platform`, `product`, `account`, `insight`, `risk`, `constraints`. Each layer is a short string with its own token estimate.

### 5. Validate budget

`withinBudget(budget, estimatedTokens)` checks against `TOKEN_BUDGETS[taskType]`. If the budget would be exceeded, the assembler returns `truncated: true` and a warning. The retriever and the assembler are both budget-aware; the assembler simply re-checks the final assembled size.

### 6. Send to provider

The AI provider receives the use case, the typed input contract, and the assembled context. Today this routes to `MockAiProvider`; when integrations ship, it will route through a server-side route handler to the real provider.

### 7. Structured output

Providers return `AiResult<U>` — a discriminated union of typed outputs (per use case). There is no freeform prose. Every output is shaped by `prompt-contracts.ts`.

### 8. Risk review

The output is fed through `quickSafetyCheck` (`src/core/ai/ai-safety-policy.ts`) plus the existing risk engine (`src/core/risk/`). Blocked outputs are filtered.

### 9. Human approval

Approved candidates land in the weekly approval queue. No content is published, commented, or posted without explicit human action. There is no agent mode; there is no autonomous loop.

## What the pipeline never does

- Send the entire workspace state to a model.
- Send the full history of comments, posts, or discussions.
- Send raw analytics dumps.
- Make a model call as a side effect of rendering.
- Publish without human approval.

## Determinism

Steps 1–5 are deterministic. The provider call (step 6) is the only step that may be non-deterministic; the structured output contract bounds what variability is allowed.

## See also

- [./memory-architecture.md](./memory-architecture.md)
- [./prompt-contracts.md](./prompt-contracts.md)
- [./safety-policy.md](./safety-policy.md)
- [./cost-policy.md](./cost-policy.md)
