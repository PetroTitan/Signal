# Media Assets (Phase F2.5)

Every publishable post must have a real creative attached — an
uploaded media file or an approved external asset URL. Prompt-only
or "planned" creatives are explicitly not publishable.

## Storage

Bucket: **`weekly-plan-creatives`** in the Signal Supabase project.

| Property | Value |
|---|---|
| Public read | ✓ |
| Auth-required write/delete | ✓ |
| File-size cap (bucket) | 100 MB |
| File-size cap (image, client-enforced) | 10 MB |
| File-size cap (video, client-enforced) | 100 MB |
| Listing exposed publicly | ✗ |

Allowed MIME types (enforced at three layers — bucket policy, table
check constraint, and the `validateUpload` server action):

```
image/jpeg, image/png, image/webp, image/gif
video/mp4, video/webm
```

Explicitly blocked: `svg`, `html`, `js`, `exe`, `zip`, `pdf`, plus
anything not on the allow-list.

Path convention:

```
weekly-plan-creatives/
  <workspace_id>/
    <weekly_plan_item_id>/
      <random uuid>.<ext>
```

- The first path segment is `workspace_id`. Storage policies extract
  it and check `is_workspace_member(uuid)` before allowing
  insert/update/delete.
- Filenames are `randomUUID()` — no operator-controlled input, no
  collision risk, no information disclosure.

## Per-upload metadata

`weekly_plan_item_creatives` carries upload provenance:

| Column | Captured at | Purpose |
|---|---|---|
| `asset_url` | upload | Public URL (operator preview + future Reddit posts) |
| `storage_path` | upload | Bucket path for delete / re-issue signed URLs |
| `mime_type` | upload | Defence-in-depth MIME guard |
| `size_bytes` | upload | Audit + quota visibility |
| `uploaded_by` | upload | `auth.users.id` of the operator |
| `uploaded_at` | upload | ISO timestamp |

The CHECK constraint `creatives_mime_whitelist` refuses any
non-allowed mime at the table layer, even on rows attached via MCP
or direct SQL.

## Creative readiness (the publish gate)

`creativeReadinessReason` returns `null` only when all of:

1. The row exists.
2. `status='approved'` (operator-explicit ack).
3. `source_type` is **not** `planned`.
4. `asset_url` OR `source_url` is present (a real reference).
5. `alt_text` is non-empty (accessibility).
6. For `source_type` ∈ {`wikimedia`, `manual_url`}: `license` AND
   `attribution` are present.
7. For `source_type='generated'`: `prompt` is present (audit trail).

Otherwise it returns one of: `creative_missing`, `creative_rejected`,
`creative_only_planned`, `creative_missing_asset`,
`creative_missing_alt_text`, `creative_missing_license_or_attribution`,
`creative_missing_prompt`, `creative_not_approved`.

## Readiness badge (the UI)

`creativeReadinessBadge` returns one of `missing | planned |
needs_review | approved | rejected`. The `/weekly-plan` row badge
and the `/approval-queue` warning copy use this:

| Badge | Status | Approve queue copy |
|---|---|---|
| `missing` | no row | "Media file required." |
| `planned` | source_type='planned' | "Creative is only planned — attach a real asset." |
| `needs_review` | row exists, status='pending_review' | "Creative not approved." |
| `approved` | row exists, status='approved', all rules pass | (no warning) |
| `rejected` | status='rejected' | "Creative was rejected." |

If a creative is `approved` but still fails one of the field checks
(e.g. no alt text), the approval queue shows the specific reason
("Alt text missing", "License/attribution missing", etc.) instead of
the generic readiness state.

## Upload flow

1. Operator picks a file in the creative form on `/weekly-plan`.
2. Browser submits the file to `uploadCreativeAssetAction`:
   - Checks auth (cookie session).
   - Validates `file.type` against `ALLOWED_MIME`.
   - Validates `file.size` (10 MB image / 100 MB video).
   - Generates `randomUUID()` filename.
   - Uploads to `<workspace_id>/<plan_item_id>/<uuid>.<ext>`.
   - Stores `asset_url`, `storage_path`, `mime_type`, `size_bytes`,
     `uploaded_by`, `uploaded_at` on the creative row.
   - Auto-status: **uploaded by the operator → status='approved'**
     immediately (the operator's explicit upload is the
     authorization).
3. Operator confirms alt text + (for external sources) license +
   attribution in the same form, ticks "Approve creative now", and
   saves.

External (MCP-attached) assets do **not** auto-approve. They land
as `pending_review` and require the operator to tick the approve
checkbox in the form.

## What MCP can and cannot do

`signal.weekly_plan.attach_creative` can:
- Set `creative_type`, `source_type`, `source_url`, `asset_url`,
  `prompt`, `alt_text`, `license`, `attribution`, `risk_notes`.
- Land the row as `pending_review` (`planned` if `source_type='planned'`).

MCP cannot:
- Upload local files (no file transfer in the HTTP bridge).
- Approve the creative (`status='approved'` requires the operator's
  cookie-bound action on /weekly-plan).
- Bypass MIME / readiness rules.

## Generating preview thumbnails

The browser handles previews natively:
- Images: `<img src={assetUrl}>` — works for jpeg, png, webp.
- Animated GIFs: same `<img>` tag, animation plays in-line.
- Videos: `<video src={assetUrl} controls muted>`.

No server-side thumbnailing in F2.5. If future surfaces need
fixed-size thumbnails, Supabase Storage's image transformations
([docs](https://supabase.com/docs/guides/storage/serving/image-transformations))
can render them at request time via a query string — no migration
needed.

## Safety summary

- No media → no publishable post.
- No alt text → no publishable post.
- External URL without license/attribution → no publishable post.
- Prompt-only creative → no publishable post (`source_type='planned'`
  blocks).
- `source_type='generated'` without `prompt` → no publishable post.
- `status` other than `approved` → no publishable post.
- Comments never require a creative (they're draft-only).

## Related

- [controlled-live-publish.md](./controlled-live-publish.md) — the
  F2.5 publish flow that consumes the creative.
- [creative-requirements.md](./creative-requirements.md) — F1
  policy on allowed sources.
