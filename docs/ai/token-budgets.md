# Token budgets

Signal caps every AI call by a per-use-case token budget. The cap is enforced before the call leaves the typed boundary; no use case can grow its budget at runtime.

## Why budgets exist

- Cost stays predictable. Budgets are the unit of cost control.
- Latency stays bounded. Small prompts return faster.
- Quality stays consistent. A tighter context window forces the retriever to send only what matters.
- The model never sees the entire workspace or history.

## The table

Defined in `TOKEN_BUDGETS` in `src/core/memory/token-budget.ts`:

| Use case | Max tokens | Warn at | Truncation strategy |
| --- | --- | --- | --- |
| `rewrite_softer` | 2000 | 80% | drop_low_relevance |
| `comment_polish` | 2000 | 80% | drop_low_relevance |
| `remove_promotional_tone` | 2000 | 80% | drop_low_relevance |
| `convert_post_to_comment` | 2500 | 80% | drop_low_relevance |
| `platform_adaptation` | 3000 | 80% | compress_long_fields |
| `generate_title_options` | 3000 | 80% | drop_low_relevance |
| `summarize_opportunity` | 3000 | 80% | compress_long_fields |
| `explain_risk` | 3000 | 80% | compress_long_fields |
| `insight_extraction` | 4000 | 85% | compress_long_fields |
| `draft_variant` | 5000 | 85% | limit_layers |

A separate planning use case (when introduced) may use up to 8000 tokens. It is not enabled today.

## Estimating tokens

`estimateTokens(text)` approximates at 4 characters per token. It is intentionally simple; the exact model tokenizer is not used because:

- The estimate is deterministic and dependency-free.
- The estimate slightly over-counts whitespace-heavy content, which is the safer direction.
- The cap is the cap. A real provider will reject anything over its own context window, and Signal stays well under.

For more precise accounting, swap `estimateTokens` for a real tokenizer at the provider boundary. The rest of the layer does not need to change.

## Truncation strategies

- `drop_low_relevance` — drop the lowest-ranked items until the budget fits. Used for short tasks where context fragments are interchangeable.
- `compress_long_fields` — shorten long memory fields (positioning summaries, audience descriptions) before dropping items.
- `limit_layers` — drop entire `insight`/`historical_pattern` layers first; keep workspace + platform + product + account + risk.

The current `MockMemoryRetriever` uses `drop_low_relevance` for retrieval. The other strategies are planned for the assembler when integrations ship.

## Warnings

`withinBudget(budget, estimatedTokens)` returns `{ ok, warn, percentUsed, reason? }`. The debug UI at `/settings/ai-memory` surfaces both the percentage used and any warning text.

## Operational principle

Signal should feel like a structured operational system, not a giant prompt wrapper. Token budgets are the contract that makes that true.
