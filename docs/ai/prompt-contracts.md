# Prompt contracts

Every allowed AI use case in Signal has a typed contract. The contract names the input shape, the output shape, the maximum output length, the allowed tones, the blocked claim patterns, and the required disclaimers.

Source: [src/core/ai/prompt-contracts.ts](../../src/core/ai/prompt-contracts.ts) and [src/core/ai/structured-outputs.ts](../../src/core/ai/structured-outputs.ts).

## Why contracts

LLM output is freeform by default. Signal isn't. Every AI call returns a typed payload that the UI can render without parsing prose. That makes every output safer, smaller, and easier to validate.

## Allowed use cases

| Use case | Input | Output |
|---|---|---|
| `rewrite_softer` | text, knownHooks? | text, changes_made, risk_reduction_notes, remaining_warnings |
| `draft_variant` | insight, platform, contentType, productPositioning?, allowedCtaCopy? | DraftVariantOutput |
| `comment_polish` | thread title/summary, draft body, platform | comment_text, relevance_reason, promotional_risk, should_post, skip_reason? |
| `insight_extraction` | raw observation, productContext? | title, core_insight, summary, category, audiences |
| `platform_adaptation` | insight, target platforms | variants[] |
| `summarize_opportunity` | title, rationale | one_line, rationale, suggested_action |
| `explain_risk` | RiskScore, hook, body | summary, reasons, recommendation, blocked_actions |
| `convert_post_to_comment` | postBody, cta?, hasLink | comment_text, removed_cta, removed_link, rationale |
| `remove_promotional_tone` | text | text, removed_phrases, kept_intent |
| `generate_title_options` | body, platform, count? | options[] |

## Shared rules

Each contract carries shared restrictions:

- **maxOutputChars** — caps prompt cost and output length.
- **allowedTone** — every use case restricts to `calm` and/or `moderate`. None allow `direct`.
- **blockedClaims** — `guaranteed results`, `100% safe`, `viral`, `10x growth`, `best in class`, `fake testimonials`, `invented metrics`, `policy bypass`.
- **requiredDisclaimers** — most use cases require "AI output requires human approval before publication."

## How a real implementation should use these

The server-side adapter for a real LLM (Phase 11+) should:

1. Build the prompt from a template seeded by the contract's `description`, plus the input fields.
2. Set a `max_tokens` derived from `maxOutputChars`.
3. Request structured output (JSON schema or function calling) that matches the contract's payload type.
4. Reject any response that fails validation, or that contains any string matching `blockedClaims`.
5. Append `requiredDisclaimers` to the rendered UI surface (not the AI input).

## What contracts never permit

- No use case in this catalogue accepts arbitrary user prompt text. The input is always structured.
- No use case generates "marketing copy at scale" — Signal does not generate volume.
- No use case may chain calls without a fresh human review in between.
