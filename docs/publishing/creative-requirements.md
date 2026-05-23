# Creative Requirements (Phase F1)

Every publishable post must have a creative asset attached before the
approval queue will let it through. This is a hard rule, not a
soft warning — `approveWeeklyPlanAction` skips items whose creatives
fail readiness with an explicit reason code.

## Data model

The [weekly_plan_item_creatives](../../supabase/migrations/20260522100001_phase_f1_creative_assets.sql)
table holds the creative plan for each `weekly_plan_item`.

| Column | Type | Notes |
|--------|------|-------|
| `creative_type` | `'image' \| 'video' \| 'animation'` | Required |
| `source_type` | enum | See below — drives license rules |
| `source_url` | text | Original asset URL (Wikimedia, manual URL) |
| `asset_url` | text | Final URL once uploaded to the platform |
| `prompt` | text | For `generated` creatives — required |
| `alt_text` | text | **Required before publish** for accessibility |
| `license` | text | "CC-BY-4.0", "Public Domain", "© Acme", etc. |
| `attribution` | text | "by Jane Doe via Wikimedia Commons" |
| `risk_notes` | text | Reviewer notes |
| `status` | enum | `planned \| pending_review \| approved \| rejected` |

## Allowed sources

| `source_type` | Use for |
|---------------|---------|
| `uploaded` | Operator-uploaded file (laptop / phone) |
| `generated` | AI-generated image/video/animation — **prompt required** |
| `wikimedia` | Wikimedia / public-domain / Creative Commons — **source_url + license + attribution required** |
| `official_source` | Product screenshot, marketing site asset |
| `manual_url` | Arbitrary URL — **source_url + license required** |
| `planned` | Placeholder while operator decides — blocks approval |

## Disallowed sources

- **Random Google Images** — copyright unknown.
- **Pinterest** — copyright unknown; most pinners are not the
  rights-holder.
- **Stock images without license** — paid stock requires a license
  string; free stock requires its CC/PD attribution.
- **AI-generated historical or factual photos presented as real**
  — passing off generated content as documentary photography is
  out of scope.

These are policy decisions, not technical limitations. The schema
won't reject them; the operator review will.

## Readiness check

[`creativeReadinessReason`](../../src/repositories/weekly-plan-creative-repository.ts)
returns `null` on pass, or one of these reason codes:

| Code | Meaning |
|------|---------|
| `creative_missing` | No row in `weekly_plan_item_creatives` for this item |
| `creative_rejected` | Operator rejected the creative |
| `creative_only_planned` | `source_type='planned'` — placeholder only |
| `creative_missing_alt_text` | `alt_text` is empty |
| `creative_missing_license_or_attribution` | External source without both fields |
| `creative_missing_prompt` | `source_type='generated'` without a prompt |

`approveWeeklyPlanAction` calls this for every pending item and adds
a warning per skipped item rather than failing the whole batch — the
operator sees what's missing for each.

## What MCP operators should write

When an external operator (Claude, Codex, custom agent) calls
`signal.weekly_plan.prepare_item` for a post, include the creative
plan in the same call:

```jsonc
{
  "title": "Build-in-public update about Signal MCP bridge",
  "body": "…",
  "platform": "reddit",
  "content_type": "post",
  "scheduled_at": "2026-05-24T14:00:00Z",
  "timezone": "Europe/Berlin",
  "creative_required": true,
  "creative_type": "image",
  "creative_source_type": "generated",
  "creative_prompt": "A clean workflow diagram showing Claude/Codex → Signal MCP → weekly approval → scheduled publishing.",
  "creative_alt_text": "Diagram of an AI operator workflow connected to Signal MCP."
}
```

If the operator hasn't decided the creative yet, pass nothing —
Signal drops a `planned` placeholder so the operator sees
"creative missing" on `/approval-queue` and knows to attach one via
`signal.weekly_plan.attach_creative` or the UI.

## Comments

Comments (`content_type=comment`) are **draft-only** in Phase F1.
They don't require creatives and they can't enter the publishing
queue. Approving a comment in the approval queue marks it
`approved` and leaves it as a private holding-pen item; nothing
publishes it.

Future comment support is reserved for **replies to users who
commented under our own published posts** — never cold outbound
commenting. That feature is explicitly deferred.

## Safety summary

- No creative → no publishable post.
- No `scheduled_at` → no publishable post.
- No confirmed product/account → no publishable post.
- No OAuth → no live publish.
- Every external creative needs an explicit license + attribution.
- Every creative needs alt text before publishing.
- Comments are not live-published in this phase, period.
