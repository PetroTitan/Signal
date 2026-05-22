# Screenshot import assistant

The flow Claude / Codex uses to map a screenshot or pasted text into a structured account or product record. Lives at `/imports` in the UI; the contracts live in `src/core/mcp-operations/screenshot-import-contracts.ts`.

## What the assistant produces

A confidence-tagged extraction object. Every field carries a value (or `null`) plus a 0–1 confidence score. The UI renders any field below `LOW_CONFIDENCE_THRESHOLD` (0.6) as needs-review.

## Account extraction shape

```ts
{
  platform: "reddit" | "x" | "linkedin" | "google" | "unknown",
  handle:           { value: string | null, confidence: number },
  display_name:     { value: string | null, confidence: number },
  bio:              { value: string | null, confidence: number },
  profile_url:      { value: string | null, confidence: number },
  visible_status:   { value: string | null, confidence: number },
  warnings: string[],
  requires_user_confirmation: true
}
```

## Product extraction shape

```ts
{
  name:           { value: string | null, confidence: number },
  domain:         { value: string | null, confidence: number },
  category:       { value: string | null, confidence: number },
  short_summary:  { value: string | null, confidence: number },
  audience:       { value: string | null, confidence: number },
  positioning:    { value: string | null, confidence: number },
  allowed_topics: { value: string[] | null, confidence: number },
  blocked_claims: { value: string[] | null, confidence: number },
  warnings: string[],
  requires_user_confirmation: true
}
```

## Hard rules

The extractor never produces, never persists, and never forwards:

- Passwords.
- Cookies or session tokens.
- 2FA codes.
- Recovery codes.
- Private message content.

The exclusion list is encoded in code as `NEVER_EXTRACT_FIELDS`. If a screenshot happens to contain any of these, the extractor's job is to drop them; flagging them in `warnings` is acceptable.

## Storage

The screenshot itself is not persisted. Only the extracted fields are written, and only after the user confirms in `/imports`. If a future phase introduces an opt-in archive of screenshots, it will require an explicit setting and a Supabase storage bucket with workspace-scoped policies.

## Confidence thresholds

- `>= 0.85` — auto-fill the field, badge as "high confidence".
- `0.6 – 0.85` — auto-fill, badge as "review".
- `< 0.6` — leave the input empty, mark as "needs edit".

Confidence does not change the policy: every imported record still lands as `pending_review` unless the user clicked Confirm.

## Where it writes

- `importProductFromScreenshot()` in `src/repositories/admin-operations/product-import-operations.ts`.
- `importAccountFromScreenshot()` in `src/repositories/admin-operations/account-import-operations.ts`.

Both set `source = "screenshot_import"`, `review_status = "pending_review"` (or `confirmed` if the user explicitly opted in), and best-effort log to `activity_events`.

## See also

- [./product-account-mapping.md](./product-account-mapping.md)
- [./approval-gated-operations.md](./approval-gated-operations.md)
