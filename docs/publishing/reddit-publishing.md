# Reddit Publishing (Phase F1)

Signal's Reddit publisher is the only fully-implemented publisher in
Phase F1. It posts **text posts** and **link posts** to a subreddit
via Reddit's official OAuth API. Comments, DMs, votes, moderation,
and scraping are explicitly out of scope.

## API call

`POST https://oauth.reddit.com/api/submit` with
`Content-Type: application/x-www-form-urlencoded`.

Required headers:

```
Authorization: bearer <oauth_access_token>
User-Agent:    web:com.webmasterid.signal:v0.1 (by /u/Webmasterid-core)
```

The User-Agent string is **mandatory** and must follow Reddit's
format (`<platform>:<app-id>:<version> (by /u/<username>)`).
Reddit silently rate-limits or blocks generic agents. The constant
lives at the top of
[`publish-reddit.ts`](../../src/core/publishing/publish-reddit.ts) —
update the version when the schema changes.

Body fields:

| Field | Value |
|-------|-------|
| `sr` | Subreddit name (no `r/` prefix) — pulled from the plan item's `platform_target` or metadata |
| `title` | Plan item title (max 300 chars) |
| `kind` | `self` for text, `link` for URL |
| `text` | Plan item body (text posts only) |
| `url` | Plan item link_url (link posts only) |
| `api_type` | `json` (always) |
| `sendreplies` | `false` |

## Response shape

Reddit returns:

```json
{
  "json": {
    "errors": [],
    "data": { "url": "...", "id": "...", "name": "t3_..." }
  }
}
```

`publishToReddit` returns the post URL on success. If `errors` is
non-empty, returns `publishFail` with reason `platform_error` and
the error array in `details`.

## Status code handling

| Code | Outcome | Reason |
|------|---------|--------|
| 200 + `errors=[]` | `published` | — |
| 200 + `errors=[...]` | `failed` | `platform_error` |
| 401 | `blocked` | `oauth_expired` |
| 403 | `blocked` | `oauth_insufficient_scope` |
| 429 | `skipped` | `rate_limited` (retried next tick) |
| 4xx | `failed` | `platform_4xx` |
| 5xx | `skipped` | `platform_5xx` (retried next tick) |
| network error | `skipped` | `network_error` |

## What's intentionally missing

- Subreddit rules check (manual operator responsibility).
- Crosspost (`kind=crosspost`).
- Flair selection.
- Sticky / mod tools.
- Multi-account round-robin (one item = one account = one POST).
