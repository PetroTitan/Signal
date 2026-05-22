# AI memory architecture

Signal does not send giant prompts. The memory layer is built so the AI receives small, relevant, compressed, task-specific context — never the whole workspace, never the full history.

This document captures what memory looks like, how it is retrieved, and what invariants the layer guarantees.

## The eight memory entity kinds

All entities live under `src/types/memory/`. Every one of them carries `schemaVersion`, `lastUpdatedAt` (where applicable), and an `active` flag so the schema can evolve without losing history.

| Kind | Purpose | Serialized target |
| --- | --- | --- |
| `WorkspaceMemory` | Tone, communication style, promotion level, risk tolerance, cadence policy, link policy | < 2 KB |
| `PlatformMemory` | Platform-native style, formats, blocked behaviors, cadence + link + tone + anti-spam + engagement risk rules | < 1 KB |
| `ProductMemory` | Compressed product profile: summary, audience, positioning, allowed/blocked topics, claim restrictions, content angles | < 2 KB |
| `AccountMemory` | Per-account health: cadence/calm/health scores, warm-up stage, content mix, recent risk/success patterns, cooldown state | < 1 KB |
| `HistoricalPattern` | Compressed learnings (e.g. "reddit_comments_without_links_perform_better" with confidence + support count) | < 512 B |
| `RiskMemory` | Reusable risk patterns with severity, triggers, recommended fix | < 1 KB |
| `AiPreference` | Per-use-case preferences: variant count, style hint, blocked/preferred tokens | < 512 B |
| `BlockedPhrase` | Scoped phrase bans with reason and severity | < 256 B |

The size targets are guidance, not enforcement at the type level. They drive the relevance ranking and the budget cap.

## What memory never stores

- Passwords, cookies, session tokens, 2FA codes, recovery codes.
- Browser fingerprints, proxy configuration, anti-detect profiles.
- Full comment threads, full discussion histories, full analytics dumps.
- Long unstructured blobs. Every field is typed and length-bounded.

The `CONNECTION_POLICY.neverAsk` list in `src/core/platform-connections/connection-policy.ts` codifies the secret rule for connections; the memory layer follows the same posture by construction (there are no fields for any of those values).

## Retrieval pipeline

```
MemoryRetrievalQuery
  → MockMemoryRetriever.retrieve
      → toScorable (filter active, drop inactive)
      → rankMemoryItems (relevance scoring)
      → budget-respecting selection
  → MemoryRetrievalResult
      → assembleContext
          → AssembledContext (layered, token-counted, truncation flag)
```

A retrieval call **does not** make any model calls. It is pure, deterministic, and cap-bounded.

## Relevance ranking

Weights are encoded in `src/core/memory/relevance-ranking.ts`:

| Factor | Bonus |
| --- | --- |
| Same platform as query | +0.30 |
| Same product as query | +0.30 |
| Same account as query | +0.20 |
| Use-case match | +0.20 |
| Confidence (0–1) | +0.10 max |
| Recency (30-day half-life) | +0.10 max |

Base relevance per kind: workspace 0.55, blocked_phrase 0.50, platform/product/account 0.45, risk 0.40, ai_preference 0.35, historical_pattern 0.30.

Scores are clamped to `[0, 1]`. The retriever sorts descending and caps by token budget and `maxItems`.

## Token budgets

Defined in `TOKEN_BUDGETS` in `src/core/memory/token-budget.ts`:

| Use case | Max tokens | Truncation strategy |
| --- | --- | --- |
| `rewrite_softer` | 2000 | drop_low_relevance |
| `comment_polish` | 2000 | drop_low_relevance |
| `remove_promotional_tone` | 2000 | drop_low_relevance |
| `convert_post_to_comment` | 2500 | drop_low_relevance |
| `platform_adaptation` | 3000 | compress_long_fields |
| `generate_title_options` | 3000 | drop_low_relevance |
| `summarize_opportunity` | 3000 | compress_long_fields |
| `explain_risk` | 3000 | compress_long_fields |
| `insight_extraction` | 4000 | compress_long_fields |
| `draft_variant` | 5000 | limit_layers |

`estimateTokens(text)` approximates at 4 characters per token. The retriever and the assembler both respect the budget; if either has to drop content, the result is flagged `truncated: true` and surfaced in the debug UI.

## Context assembly

`assembleContext({ taskType, retrieval })` builds layered prompt material:

- `system` — Signal's invariants (human-approved, no fake metrics, no autonomous posting).
- `workspace` — tone, style, promotion, risk, link, cadence summaries.
- `platform` — preferred style, formats, blocked behaviors, link rules, cadence min hours.
- `product` — short summary, audience, positioning, allowed/blocked topics.
- `account` — handle, warmup stage, cadence/calm/health scores, cooldown.
- `insight` — top historical patterns with confidence and support counts.
- `risk` — top risk patterns with recommended fixes.
- `constraints` — blocked phrases.

Each layer carries its own `estimatedTokens`. Total context per task should comfortably fit inside its token budget.

## Compression

`compressEventsToPatterns()` in `src/core/memory/memory-compression.ts` collapses raw events into `HistoricalPattern` objects bucketed by `(kind, platform, product, signal)`. Confidence is positives over total. Relevance decays for low support counts. Patterns are recomputed periodically — never appended unbounded.

## Determinism

For the same memory snapshot and the same query, retrieval returns the same items in the same order. No randomness, no model calls. The same applies to context assembly.

## Schema evolution

Every entity has a `schemaVersion: number`. Producers and consumers should:

- Add new fields as optional first.
- Bump `schemaVersion` only when an existing field's meaning changes.
- Keep old fields readable until a migration path is in place.
- Use the `active` flag to retire entries without deletion.

See `docs/database/memory-schema-plan.md` for the future Supabase mapping.

## See also

- [./prompt-contracts.md](./prompt-contracts.md)
- [./cost-policy.md](./cost-policy.md)
- [./safety-policy.md](./safety-policy.md)
- [./context-pipeline.md](./context-pipeline.md)
- [../database/memory-schema-plan.md](../database/memory-schema-plan.md)
