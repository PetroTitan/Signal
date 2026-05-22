# Import runtime preparation

`/imports` now has working textareas for product and account intake. The action behind them does **not** run AI extraction inside Signal — extraction runs in the operator's connected assistant. What Signal does is:

1. Record an `mcp_operation_runs` row with status `pending_approval`.
2. Tag it with the operation type (`product_profile_suggest` or `account_profile_suggest`).
3. Write an `import.requested` activity event.
4. Show the operator the run id and the honest message: "Extraction request can be prepared, but AI extraction is not connected inside Signal yet."

## What this gets you

- A complete audit row for every import request, including source length and timestamp.
- A way for Claude / Codex / Opus to find the request via `mcp_operation_runs` and produce a structured extraction.
- A reservation slot — when extraction is wired, the same operation row can be promoted from `pending_approval` to `running` / `completed` without changing the UI.

## What this does not do

- No screenshot upload. Phase E2.6 deliberately skips it; the docs are at [../mcp/screenshot-import-assistant.md](./screenshot-import-assistant.md).
- No automatic field extraction. Source text is only saved as input summary metadata; no fields are auto-applied to products or accounts.
- No `confirmed` records created. If extraction does run, the resulting product or account row will land with `review_status='pending_review'` and must be confirmed.

## Server action

```ts
prepareImportAction(prev, formData) → ActionResult<{
  runId: string;
  status: "pending_approval";
  message: string;
}>
```

Input: `kind` (`"product" | "account"`), `source_text` (string, required).

Failure modes:

- `Unknown import kind.` — `kind` is not `product` or `account`.
- `Paste a product description or account profile first.` — empty source text.
- `No workspace found.` — operator has no workspace membership.
- Repository errors propagate as-is via `actionFail`.

## Never-extract fields

The contract layer keeps the never-extract list (`NEVER_EXTRACT_FIELDS`) — passwords, cookies, session tokens, 2FA codes, recovery codes, billing details, etc. The extractor refuses these fields by design. The list is rendered on `/imports` so the operator can see it.

## See also

- [./real-mcp-runtime-integration.md](./real-mcp-runtime-integration.md)
- [./screenshot-import-assistant.md](./screenshot-import-assistant.md)
- [./operation-approval-ui.md](./operation-approval-ui.md)
