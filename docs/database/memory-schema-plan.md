# Memory schema plan

Future Supabase mapping for the AI memory layer. Today everything lives in `MockMemoryRetriever`; the schema below is what gets created when persistence ships.

## Goals

- One typed table per entity kind. No giant unstructured blobs.
- `schema_version` on every row, so we can evolve in place.
- Indexes shaped to the retrieval queries the app actually runs.
- Compression lifecycle is part of the schema, not an afterthought.

## Tables

### `workspace_memory`

| Column | Type | Notes |
| --- | --- | --- |
| `workspace_id` (PK) | uuid | One row per workspace |
| `schema_version` | int | Default 1 |
| `workspace_name` | text | |
| `tone` | enum | warm \| neutral \| direct \| playful |
| `communication_style` | enum | founder_first_person \| team_voice \| conversational \| expert |
| `promotion_level` | enum | minimal \| balanced \| moderate |
| `risk_tolerance` | enum | low \| medium \| high |
| `link_policy` | enum | platform_native \| rare \| off |
| `cadence_policy` | enum | calm \| regular \| active |
| `preferred_platforms` | text[] | Max 4 |
| `blocked_phrases` | text[] | Max 20, length ≤ 64 |
| `preferred_phrases` | text[] | Max 20 |
| `writing_style_summary` | text | ≤ 240 chars |
| `operational_summary` | text | ≤ 240 chars |
| `source` | enum | user \| derived \| default |
| `active` | bool | |
| `last_updated_at` | timestamptz | |

### `platform_memory`

Composite key: `(workspace_id, platform)`. JSONB only for `cadence_rules` and `link_rules` to keep arrays of rules typed at the application boundary; everything else is typed columns.

### `product_memory`

Composite key: `(workspace_id, product_id)`. Length caps mirror `PRODUCT_MEMORY_LIMITS`. Optional `embedding` column (vector) reserved for future similarity ranking.

### `account_memory`

Composite key: `(workspace_id, account_id)`. Numeric scores (`cadence_score`, `calm_score`, `health_score`) are `numeric(3,2)` for stable rounding. Cooldown lives in a JSONB `posting_cooldown_state` to preserve the small substructure without splitting it across columns.

### `historical_pattern`

| Column | Type | Notes |
| --- | --- | --- |
| `id` (PK) | text | Stable hash of bucket key |
| `workspace_id` | uuid | |
| `pattern` | text | ≤ 200 chars |
| `kind` | enum | cadence \| engagement \| discoverability \| risk \| tone \| platform_native |
| `platform` | text | Channel or `any` |
| `product_id` | uuid | Nullable |
| `confidence` | numeric(3,2) | 0..1 |
| `supporting_events` | int | |
| `last_seen_at` | timestamptz | |
| `relevance_score` | numeric(3,2) | Derived |
| `active` | bool | |

### `risk_memory`, `ai_preference`, `blocked_phrase`

Mirror the type files one-to-one. Each carries `schema_version`, `last_updated_at`, and `active`.

## Indexes

Retrieval is the primary read pattern. Index for it.

- `workspace_memory (workspace_id)` — covered by PK.
- `platform_memory (workspace_id, platform)` — covered by composite PK.
- `product_memory (workspace_id, product_id)`.
- `account_memory (workspace_id, platform, account_id)` — supports per-platform lookups.
- `historical_pattern (workspace_id, platform, product_id, relevance_score DESC)` — primary retrieval path.
- `historical_pattern (workspace_id, kind, last_seen_at DESC)` — supports decay.
- `risk_memory (workspace_id, platform, severity)`.
- `ai_preference (workspace_id, use_case)`.
- `blocked_phrase (workspace_id, scope, scope_ref_id)`.

Add a partial index on `active = true` for the hot tables to keep retrieval scans tight.

## Retrieval query strategy

The retriever runs one query per kind, ranked by the same scoring function the application uses today. This keeps each query indexable and bounded:

```sql
SELECT ... FROM historical_pattern
WHERE workspace_id = $1
  AND active
  AND (platform = $2 OR platform = 'any')
  AND (product_id = $3 OR product_id IS NULL)
ORDER BY relevance_score DESC
LIMIT $maxItemsPerKind;
```

The application then ranks across kinds and trims by token budget. This is the same shape `MockMemoryRetriever` uses today.

## Relevance query strategy

Server-side ranking can stay the way the app does it now (deterministic scoring in Postgres or in the route handler). When the snapshot grows, the same weights become a stored function. We do not adopt vector search until the structured retrieval no longer fits the workload.

## Compression lifecycle

- Raw events live in a separate `growth_event` table (already planned in the broader Supabase plan).
- A scheduled job calls `compressEventsToPatterns` over a rolling window.
- Output rows upsert into `historical_pattern` keyed by the bucket hash.
- Patterns with `supporting_events < 2` and `last_seen_at < now() - interval '180 days'` are pruned.

No table ever grows unbounded. The retrieval surface is always small.

## Migration safety

Every table carries `schema_version`. New fields are added as nullable first. Renames go through a documented two-phase migration. Deletes are flagged with `active = false` before any row is removed. Approved drafts and approval events are preserved across schema changes.

## What is intentionally not in this schema

- Passwords, cookies, session tokens, 2FA codes, recovery codes.
- Browser fingerprints, proxy configuration, anti-detect profiles.
- Raw discussion threads, raw comment bodies in bulk.
- Free-form unstructured "context blobs" that anyone can dump into.

If a future requirement looks like it needs one of these, the requirement is wrong.

## See also

- [./oauth-token-storage-plan.md](./oauth-token-storage-plan.md)
- [./rls-security-plan.md](./rls-security-plan.md)
- [./supabase-schema-plan.md](./supabase-schema-plan.md)
- [../ai/memory-architecture.md](../ai/memory-architecture.md)
- [../ai/context-pipeline.md](../ai/context-pipeline.md)
