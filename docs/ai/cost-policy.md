# AI cost policy

Signal optimizes for sustainable presence, not posting volume. The AI cost policy follows the same shape: it's designed to keep cost low and behavior calm.

Source: [src/core/ai/ai-cost-policy.ts](../../src/core/ai/ai-cost-policy.ts).

## Rules

- **No AI calls on render.** The provider is never invoked from a React render path.
- **No background loops.** No silent retries, no agents, no autonomous regeneration.
- **Human-triggered only.** Every call is the result of a click — "Soften," "Generate variant," "Explain risk."
- **Batch-friendly workflows.** When a real provider lands, multiple short tasks fan into one API call where possible.
- **Outputs are cacheable.** A `(useCase, input hash)` cache key is sufficient for most calls; re-running the same input returns the cached output.
- **Cheap models for cheap work.** `rewrite_softer`, `remove_promotional_tone`, `convert_post_to_comment`, `summarize_opportunity`, `explain_risk`, and `generate_title_options` are short transforms; they use the cheapest acceptable model.
- **Expensive models for final polish.** `draft_variant`, `platform_adaptation`, `insight_extraction`, and `comment_polish` are reserved for high-value work.
- **Soft limits per workspace.** A per-workspace weekly token soft budget and per-workspace weekly call soft cap exist as code-level constants today; billing enforcement ships with persistence.

## Variants per request

A single AI call returns at most 3 variants. This is a hard limit, not a target. Founders compare, choose, edit. Signal does not return 10 variants because returning 10 produces noise, not options.

## What this policy never allows

- **Idle generation.** No "while idle, pre-generate next week" path.
- **Speculative drafts.** Drafts only get generated when the founder asks for them.
- **Hidden retries.** Errors surface; they don't trigger background calls.
- **Cost-unbounded operations.** Every operation has a `maxOutputChars` ceiling. The server-side provider clamps `max_tokens` to a derived limit.

## Future evolution

When billing arrives:

- Per-workspace token budget moves from soft to enforced.
- Operations that exceed the budget return a `quota_exceeded` AiError; the UI shows "Workspace AI budget reached. New requests resume next week."
- The founder can lift their cap from billing settings; the cap doesn't disappear, it expands.
