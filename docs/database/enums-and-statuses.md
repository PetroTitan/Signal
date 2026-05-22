# Enums and statuses

Catalogue of every enum the future Supabase schema will declare. Each enum keeps a name, the canonical set of values, and the source TypeScript union.

Naming convention: Postgres enums are `snake_case`. TypeScript unions are `kebab_lowercase` or `snake_case` already. Values are kept identical between TS and SQL.

## Platforms

### `social_platform`

```sql
create type social_platform as enum ('reddit', 'x', 'linkedin');
```

Source: `PlatformId` in `src/types/platform.ts`. Google is **not** a social platform; it lives in the discoverability layer as a separate string column where needed (e.g. `activity_events.platform`, `tracking_links.platform`).

## Account system

### `account_role`

```sql
create type account_role as enum (
  'founder', 'product', 'support', 'research', 'community'
);
```

### `account_status`

```sql
create type account_status as enum (
  'planned',
  'setup_needed',
  'awaiting_manual_creation',
  'ready_to_connect',
  'connected',
  'warming',
  'active',
  'paused'
);
```

### `checklist_category`

```sql
create type checklist_category as enum (
  'kit', 'manual', 'security', 'profile', 'oauth', 'planning'
);
```

## Workspace

### `workspace_role`

```sql
create type workspace_role as enum (
  'owner', 'admin', 'editor', 'reviewer', 'viewer'
);
```

## Products

### `product_category`

```sql
create type product_category as enum (
  'analytics', 'finance', 'communication', 'productivity', 'utility', 'consulting'
);
```

### `cta_style`

```sql
create type cta_style as enum (
  'no_cta', 'soft_mention', 'contextual_link', 'direct_signup'
);
```

### `risk_tolerance`

```sql
create type risk_tolerance as enum (
  'conservative', 'balanced', 'assertive'
);
```

## Weekly operations

### `weekly_plan_status`

```sql
create type weekly_plan_status as enum (
  'drafting', 'awaiting_approval', 'approved', 'in_progress', 'complete'
);
```

### `plan_item_status`

```sql
create type plan_item_status as enum (
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'scheduled',
  'published',
  'skipped',
  'backlog',
  'paused'
);
```

### `content_type`

```sql
create type content_type as enum (
  'discussion_post',
  'tutorial',
  'case_study',
  'comment_reply',
  'thread',
  'announcement',
  'long_form_article'
);
```

### `approval_action`

```sql
create type approval_action as enum (
  'approve',
  'reject',
  'edit',
  'rewrite_softer',
  'remove_link',
  'delay',
  'convert_to_comment',
  'save_to_backlog'
);
```

## Risk

### `risk_level`

```sql
create type risk_level as enum ('low', 'medium', 'high', 'blocked');
```

### `risk_category`

```sql
create type risk_category as enum (
  'duplicate_content',
  'link_repetition',
  'overposting',
  'synchronized_posting',
  'promotional_tone',
  'account_fatigue',
  'platform_cadence'
);
```

## Content intelligence

### `insight_category`

```sql
create type insight_category as enum (
  'founder_observation',
  'product_lesson',
  'support_pattern',
  'workflow_problem',
  'user_problem',
  'seo_opportunity',
  'discoverability_gap',
  'industry_pattern',
  'operational_lesson',
  'evergreen_topic'
);
```

### `insight_audience`

`audience` is stored as JSONB (an array of audience tokens). Token vocabulary:

```
founders, operators, developers, freelancers,
small_business, support_teams, marketers, general
```

### `platform_fit_level`

`platform_fit` is JSONB. Each platform has a level token:

```
strong, medium, weak, none
```

### `content_opportunity_kind`

```sql
create type content_opportunity_kind as enum (
  'discussion_post',
  'question_post',
  'founder_lesson',
  'soft_feedback_request',
  'helpful_comment',
  'short_post',
  'thread',
  'reply',
  'build_in_public_update',
  'founder_observation',
  'authority_post',
  'professional_insight',
  'case_study',
  'thoughtful_comment',
  'discoverability_signal'
);
```

### `opportunity_impact`

```sql
create type opportunity_impact as enum ('low', 'medium', 'high');
```

### `opportunity_status`

```sql
create type opportunity_status as enum (
  'candidate', 'drafted', 'queued', 'approved', 'skipped'
);
```

### `tone_strength`

```sql
create type tone_strength as enum ('calm', 'moderate', 'direct');
```

### `cta_intensity`

```sql
create type cta_intensity as enum ('none', 'soft', 'contextual');
```

### `guardrail_flag`

Stored as JSONB array of tokens. Token vocabulary:

```
cta_too_aggressive, repeated_wording, duplicate_hook, low_context,
launch_language, fake_certainty, unsupported_claim, startup_cliche,
ai_voice, generic_phrasing
```

## Comment intelligence

### `discussion_context`

```sql
create type discussion_context as enum (
  'subreddit_thread', 'x_thread', 'linkedin_post'
);
```

### `participation_recommendation`

```sql
create type participation_recommendation as enum (
  'participate', 'watch', 'skip'
);
```

### `community_fit_level`

JSONB inside `community_fit`. Tokens:

```
strong, medium, weak, off_topic
```

### `conversation_risk_level`

Reuses `risk_level`. No separate enum.

## Discoverability

### `freshness_status`

```sql
create type freshness_status as enum (
  'fresh', 'evergreen', 'needs_refresh', 'stale', 'under_promoted'
);
```

Note: `freshness` itself is **computed**, not stored. The enum exists so `freshness_snapshots` (if used) can declare a typed column.

### `content_asset_kind`

```sql
create type content_asset_kind as enum (
  'blog_post',
  'landing_page',
  'case_study',
  'guide',
  'documentation',
  'release_notes',
  'comparison',
  'tutorial'
);
```

### `discoverability_opportunity_kind`

```sql
create type discoverability_opportunity_kind as enum (
  'low_amplification',
  'search_to_social',
  'social_to_search',
  'topic_cluster_gap',
  'freshness_refresh',
  'internal_linking',
  'evergreen_distribution'
);
```

### `discoverability_impact`

Reuses `opportunity_impact`. No separate enum.

### `youtube_format_kind`

```sql
create type youtube_format_kind as enum (
  'shorts', 'founder_video', 'community_update', 'long_form'
);
```

### `topical_cluster_coverage`

JSONB inside `topical_clusters`. Tokens:

```
covered, thin, missing
```

## Activity

### `activity_event_type`

```sql
create type activity_event_type as enum (
  'insight_created',
  'opportunity_generated',
  'draft_created',
  'comment_drafted',
  'thread_skipped',
  'item_approved',
  'item_rejected',
  'item_backlogged',
  'schedule_redistributed',
  'risk_flagged',
  'account_readiness_changed',
  'discoverability_opportunity',
  'account_created'
);
```

### `activity_entity_type`

```sql
create type activity_entity_type as enum (
  'insight',
  'opportunity',
  'draft',
  'comment',
  'discussion',
  'weekly_item',
  'backlog_item',
  'schedule',
  'risk',
  'account',
  'content_asset',
  'discoverability'
);
```

### `activity_layer`

```sql
create type activity_layer as enum (
  'core',
  'platform_social',
  'platform_search',
  'intelligence',
  'operations',
  'configuration'
);
```

### `activity_severity`

```sql
create type activity_severity as enum ('info', 'ok', 'warn', 'block');
```

## Integrations

### `connection_status`

```sql
create type connection_status as enum (
  'not_connected',
  'pending',
  'connected',
  'expired',
  'revoked',
  'error'
);
```

### `scheduled_post_status`

```sql
create type scheduled_post_status as enum (
  'queued', 'publishing', 'published', 'failed', 'cancelled'
);
```

## Evolution rules

- **Add only at the end.** Postgres allows `alter type ... add value` only by appending.
- **Never rename a value in place.** Migrations rename with a careful update step: add new value, backfill, deprecate the old one.
- **Never reorder.** Order is meaningful for some clients; treat enums as ordered append-only sets.
- **TypeScript first.** New values are added to the TypeScript union, then to the SQL enum during the migration that introduces them.
- **Google stays out of `social_platform`.** Cross-cutting fields like `activity_events.platform` use plain text. Search and discoverability tables identify Google by table membership, not by an enum value alongside Reddit/X/LinkedIn.

This catalogue is the input to the schema plan and the future migration files.
