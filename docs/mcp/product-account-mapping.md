# Product and account mapping

How structured fields are derived from a screenshot, a pasted landing page, or a short product brief. The output of a mapping is consumed by the import assistant; the import assistant decides what to persist.

## Field semantics

### Products

| Field | What goes in it | Confidence guidance |
| --- | --- | --- |
| `name` | Display name as it appears on the source. | High if the page header / favicon matches. |
| `domain` | Apex domain only. Strip `www.`, paths, query strings. | High if the source URL or footer shows a canonical domain. |
| `category` | A short, lowercase categorical phrase (e.g. `analytics`, `productivity`). | Low when the source is ambiguous; better empty than guessed. |
| `short_summary` | One- or two-sentence description in the product's own voice. | High when the source contains a tagline; medium when summarized. |
| `audience` | Who the product is for. Keep concrete (e.g. "indie founders running SaaS"). | Low unless explicitly named. |
| `positioning` | One sentence on the strategic angle. | Low unless explicit. |
| `allowed_topics` | Topics the product is willing to discuss in social copy. Derived, not invented. | Medium / low. Edit before saving. |
| `blocked_claims` | Phrases the product must never use (e.g. unverified metrics). | High when the page explicitly avoids a claim. |

### Accounts

| Field | What goes in it | Confidence guidance |
| --- | --- | --- |
| `platform` | One of `reddit`, `x`, `linkedin`, `google`, or `unknown`. | High when the screenshot has obvious platform chrome. |
| `handle` | The platform handle. Include the `u/` / `@` prefix only if the platform displays it. | High from visible profile pages. |
| `display_name` | The human-readable name shown. | High. |
| `bio` | Short profile bio. | Medium — usually visible. |
| `profile_url` | Canonical profile URL. | High if visible. |
| `visible_status` | Anything the platform shows about account status (e.g. "verified", "suspended"). | High; render to the user verbatim. |

## Hard rules

- **Do not invent metrics.** "Trusted by 10,000 founders" goes in only if the screenshot/text says so.
- **Do not invent customers.** Logo wall? Quote the actual logos. No "used by leading SaaS teams".
- **Do not invent integrations.** Only list integrations the source explicitly claims.
- **Do not invent platform permissions.** Account screenshots do not imply OAuth scopes.
- **Low-confidence fields must require edit.** The UI must badge them and never auto-confirm.

## What gets written

When the user confirms a mapping, the import-assistant repository helpers write:

- `products.source = "screenshot_import"` (or `"ai_assisted"` for text-only).
- `products.review_status = "pending_review"` until the user clicks Confirm.
- `growth_accounts.source` / `review_status` same shape.
- `activity_events` row with `event_type = "mcp.screenshot_product_import"` (or `_account_`), `operation_id` pointing at the `mcp_operation_runs` entry.

## Editing post-import

The user can:

- Promote a `pending_review` record to `confirmed`. This is itself an MCP operation (`product_profile_confirm` / `account_profile_confirm`) and lands its own `mcp_operation_runs` row.
- Mark a record as `needs_edit` or `rejected`. Rejected records stay in the table for audit but never feed downstream.

## See also

- [./screenshot-import-assistant.md](./screenshot-import-assistant.md)
- [./safe-db-operations.md](./safe-db-operations.md)
