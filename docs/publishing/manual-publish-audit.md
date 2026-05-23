# Manual Publish Audit Trail (Phase F2.6)

Every manual publish leaves the same shape of audit record as the
API path, plus explicit mode markers so the two are easy to
distinguish in retrospect.

## Tables touched on a successful manual record

| Table | What's written |
|---|---|
| `execution_items` | status `ready_for_manual_publish` (or `ready`) → `running` → `completed`. `metadata.publish_outcome.publish_method='manual'`. |
| `weekly_plan_items` | status mirrored to `published`. |
| `publish_history` | new row, `outcome='published'`, `mode='manual'`, normalized permalink + provider_post_id. |
| `execution_logs` | `item.completed` log line with permalink + provider_post_id in metadata. |
| `activity_events` | `manual_publish.recorded`. |

## Tables touched on a blocked manual record

| Table | What's written |
|---|---|
| `execution_items` | status unchanged (still `ready_for_manual_publish` or `ready`). |
| `publish_history` | new row with `outcome='blocked'`, `mode='manual'`, `reason_code` set, `provider_permalink=NULL`. |
| `execution_logs` | `item.blocked` log line with reason_code. |

Blocked attempts do NOT consume rate-limit budget (only `outcome='published'` counts).

## Distinguishing manual from API in retrospect

```sql
-- Successful publishes by mode
SELECT mode, count(*) AS n,
       array_agg(distinct subreddit) AS subs
FROM publish_history
WHERE workspace_id = $1 AND outcome = 'published'
GROUP BY mode;

-- Items where the mode column disagrees with metadata.publish_method
-- (sanity check; should be empty)
SELECT id, mode, metadata->>'publish_method' AS method, finished_at
FROM publish_history
WHERE (mode = 'manual' AND coalesce(metadata->>'publish_method','manual') <> 'manual')
   OR (mode = 'api'    AND coalesce(metadata->>'publish_method','api')    <> 'api');

-- All manual records on a specific item
SELECT id, finished_at, outcome, provider_permalink, mode,
       metadata->>'recorded_via' AS recorded_via,
       metadata->>'operator_notes' AS notes
FROM publish_history
WHERE execution_item_id = $1
ORDER BY finished_at DESC;
```

## Duplicate-permalink enforcement

DB-level partial unique index:

```sql
create unique index publish_history_workspace_permalink_unique
  on public.publish_history (workspace_id, provider_permalink)
  where provider_permalink is not null;
```

Two distinct manual records cannot store the same permalink within a
workspace. The server action and the MCP tool both check this before
the insert so the operator sees a friendly error rather than a raw
constraint violation; the DB index is the defense-in-depth backstop.

NULL permalinks (`outcome='blocked'` and `outcome='failed'` rows)
are exempt from the index — multiple blocked attempts can stack up,
which is the point of the audit trail.

## What's never logged

- The Reddit OAuth access token (we never have one on the manual
  path).
- Operator session cookies / Supabase auth state.
- Reddit account passwords / 2FA codes (Signal never sees these).
- The literal Reddit submit POST body — only the prepared payload
  derived from the plan item.

## Sample log line shapes

```
execution_logs.message:
  "[manual-publish] recorded — https://www.reddit.com/r/test/comments/abc123/"

execution_logs.event_type:
  "item.completed"

execution_logs.metadata:
  {
    "permalink":          "https://www.reddit.com/r/test/comments/abc123/",
    "provider_post_id":   "t3_abc123",
    "subreddit":          "test",
    "publish_method":     "manual",
    "mode":               "manual",
    "recorded_via":       "mcp",                  // optional, only when via MCP
    "operator_token_id":  "00000000-…"            // optional, only when via MCP
  }
```

```
activity_events.event_type:
  "manual_publish.recorded"

activity_events.title:
  "Manual publish recorded — r/test"

activity_events.description:
  "https://www.reddit.com/r/test/comments/abc123/"
```

## Verification queries

```sql
-- All manual publishes in the last 7 days
SELECT finished_at, subreddit, provider_permalink
FROM publish_history
WHERE workspace_id = $1
  AND mode = 'manual'
  AND outcome = 'published'
  AND finished_at >= now() - interval '7 days'
ORDER BY finished_at DESC;

-- Blocked manual attempts and their reasons (debugging gates)
SELECT finished_at, reason_code, metadata->>'detail' AS detail
FROM publish_history
WHERE workspace_id = $1
  AND mode = 'manual'
  AND outcome = 'blocked'
ORDER BY finished_at DESC;
```

## Related

- [manual-reddit-publishing.md](./manual-reddit-publishing.md)
- [reddit-api-approval-fallback.md](./reddit-api-approval-fallback.md)
