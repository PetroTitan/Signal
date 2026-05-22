# AI safety policy

Signal's AI safety policy is a product decision. The rules below shape the architecture so unsafe output is blocked at the door — by contract, by output validator, and by the human approval gate.

Source: [src/core/ai/ai-safety-policy.ts](../../src/core/ai/ai-safety-policy.ts).

## What AI must not generate

- **fake_metrics** — invented engagement counts, impression numbers, signups, conversions.
- **fake_testimonials** — invented customer quotes or stories.
- **fake_user_numbers** — "trusted by N companies"-style claims with no evidence.
- **fake_partnerships** — invented integrations or co-marketing relationships.
- **unsupported_claims** — universal claims ("every founder", "always", "guaranteed") without evidence.
- **aggressive_spam_ctas** — "Buy now," "Act fast," "Limited time," "Don't miss out."
- **platform_bypass_suggestions** — anything that frames around evading a platform rule.
- **engagement_manipulation_instructions** — "comment with X to game the algorithm."
- **comment_spam** — generic agreement, copy-pasted reactions.
- **account_farming_workflows** — multi-account orchestration steered around platform policy.

## What AI should prefer

- **Softer language.** Hedged phrasings over absolutes.
- **No-link versions.** When in doubt, drop the outbound link.
- **Discussion-first framing.** Comments before posts. Questions before claims.
- **Human approval.** Disclaimers state explicitly that output requires founder approval.
- **Skip recommendations.** When no real signal exists, return `should_post: false` with a `skip_reason`.

## Defense in depth

Three layers:

1. **Contracts** — input is typed; outputs are typed. Freeform prose isn't accepted.
2. **Output validator** — `quickSafetyCheck` flags aggressive CTAs and unsupported claims; outputs with `blocked: true` are discarded.
3. **Human approval** — every AI-generated item passes through the approval queue. There is no autonomous publish path.

## What this policy never allows

- A "creative mode" toggle that loosens guardrails.
- An "agent mode" that auto-loops.
- Any flow that hides AI-generated content from the human approval queue.
- An LLM tool that calls a publish endpoint directly.

## What happens when output is blocked

The UI surfaces an `AiError` with code `safety_blocked` and a calm message: "Output was blocked by the safety policy." The founder can retry with a different input or edit by hand.

The blocked output never reaches the approval queue. It is discarded.

## See also

- [ai-integration-readiness.md](./ai-integration-readiness.md)
- [prompt-contracts.md](./prompt-contracts.md)
- [../safety/operational-safety-layer.md](../safety/operational-safety-layer.md)
