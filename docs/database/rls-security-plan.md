# RLS security plan

This document defines the Row Level Security strategy Signal will adopt when Supabase persistence ships. **No policies are written yet.** This is the policy intent.

## Core principles

- **Every table is workspace-scoped.** No row exists outside a workspace except `audit_logs` rows that are explicitly cross-workspace.
- **The client role can never touch service material.** OAuth tokens, encrypted credentials, and audit logs are server-only.
- **RLS is on by default.** Every new table starts with `enable row level security` and tightly scoped policies.
- **Reads default to scoped membership; writes default to scoped membership + role.** No anonymous reads, no anonymous writes.
- **Append-only tables enforce append-only at the database, not in application code.** `update` and `delete` policies on `approval_events`, `activity_events`, `risk_events`, `account_status_history`, `audit_logs`, and `performance_events` are denied for all client roles.

## Role model

Two database roles matter:

- `authenticated` — the client running through Supabase JS / RLS. The default role for app users.
- `service_role` — server-side jobs, edge functions, and any code that handles tokens or runs cross-workspace work.

`anon` is never granted any select/insert/update/delete on Signal tables.

## Workspace membership

The single helper used everywhere:

```sql
-- Pseudocode; finalized at migration time.
create or replace function is_workspace_member(target uuid)
returns boolean as $$
  select exists (
    select 1
    from workspace_members
    where workspace_id = target
      and user_id = auth.uid()
  );
$$ language sql stable security definer;
```

Used in every workspace-scoped policy.

## Workspace roles vs database roles

`workspace_members.role` carries application-level roles: `owner`, `admin`, `editor`, `reviewer`, `viewer`. These shape *what* a member can do inside the workspace; the database role stays `authenticated`.

| Role | Inside the workspace |
|---|---|
| `owner` | Anything, including managing members and deleting the workspace. |
| `admin` | Anything except deleting the workspace. |
| `editor` | Configure products, accounts, insights; approve items; redistribute schedules. |
| `reviewer` | Approve, soften, delay, save to backlog, reject. Cannot configure products or accounts. |
| `viewer` | Read-only. |

Helper:

```sql
create or replace function workspace_role(target uuid)
returns workspace_role as $$
  select role
  from workspace_members
  where workspace_id = target
    and user_id = auth.uid();
$$ language sql stable security definer;
```

## Policy strategy by table group

### Identity & tenancy

| Table | Read | Write |
|---|---|---|
| `workspaces` | members only | owner only |
| `workspace_members` | members of the workspace | owner / admin |

### Product system

`products`:

- read: members.
- insert: editor or higher.
- update: editor or higher.
- delete: owner / admin only; consider soft-delete via `deleted_at`.

### Account system

`growth_accounts`, `account_setup_profiles`, `account_checklist_items`, `account_warmup_plans`:

- read: members.
- insert / update: editor or higher.
- delete: owner / admin.

`account_status_history`: append-only; insert allowed for editor or higher; update/delete denied for all client roles.

### Weekly operations

`weekly_plans`, `weekly_plan_items`:

- read: members.
- insert / update: editor or higher.
- delete: editor or higher. Soft-delete preferred; this is the founder's working surface.

`approval_events`:

- read: members.
- insert: editor / reviewer.
- update / delete: **denied** to all client roles.

`backlog_items`:

- read: members.
- insert / update / restore: editor or higher.

`activity_events`:

- read: members.
- insert: `service_role` only. Activity is produced by the system, never by the client.
- update / delete: denied.

### Risk

`risk_events`:

- read: members.
- insert: `service_role` (engines).
- update: limited to `resolved_at` column via a server function. Direct client update denied.
- delete: denied.

`risk_snapshots`:

- read: members.
- insert: `service_role`.
- update / delete: denied.

### Content & comment intelligence

`source_insights`:

- read: members.
- insert / update: editor or higher.
- archive (soft-delete via `archived_at`): editor or higher.

`content_opportunities`, `draft_variants`, `comment_drafts`, `reply_drafts`, `discussion_opportunities`:

- read: members.
- insert / update: editor or higher.

### Discoverability

`content_assets`:

- read: members.
- insert / update: editor or higher.

`discoverability_opportunities`, `youtube_ideas`:

- same as `content_opportunities`.

### Analytics

`tracking_links`:

- read: members.
- insert: editor or higher (or `service_role` for system-generated links).
- update / delete: editor or higher.

`campaign_attribution`, `performance_events`:

- read: members.
- insert / update: `service_role` only.
- delete: denied.

`webmasterid_connections`:

- read: members **excluding the encrypted column**.
- insert / update: owner / admin.
- the encrypted column is accessed only by server functions.

### OAuth (Phase F)

`platform_connections`:

- read: members **excluding the encrypted columns**.
- insert: server-only (the OAuth callback).
- update: server-only.
- delete: owner / admin (revocation).

The encrypted token columns are never returned to client queries. Server functions handle refresh and publish.

### System

`audit_logs`:

- read: owner / admin.
- insert: `service_role`.
- update / delete: denied.

`integration_statuses`, `settings`:

- read: members.
- insert / update: owner / admin.

## Cross-cutting rules

1. **`workspace_id` is denormalized** onto every workspace-scoped row to keep policies fast (a single index lookup rather than a join).
2. **All policies check `is_workspace_member(workspace_id)` first.** Role gating is layered on top.
3. **Service-role boundaries are explicit.** Any table that allows `service_role` inserts is documented in the migration as such, with a comment naming the writer.
4. **No client ever touches tokens.** Policies return the row minus encrypted columns via a view, or the columns are returned only by `security definer` functions.
5. **`auth.uid()` is never used inside non-policy code.** Application code reads `workspace_id` from the request scope; the database enforces the rest.

## What this plan never permits

- A query that crosses workspaces without an explicit `service_role` context.
- A client-facing endpoint that returns an OAuth token.
- An update on `approval_events`, `activity_events`, `risk_events`, `account_status_history`, `audit_logs`, or `performance_events`.
- An `update` to a `*_at` audit timestamp.
- An anonymous read.

## Future work

- **Audit policy testing.** When migrations land, every policy gets a regression test that asserts the four combinations (member vs non-member × correct role vs wrong role).
- **Service-role wrappers.** Each server-only insert path becomes a `security definer` function with an explicit allow-list of columns.
- **Token rotation.** OAuth refresh paths land in Phase F with their own audit log entries.

Until then, the schema plan and this document are the contract: no client touches tokens, no policy lets a non-member see a row, and append-only means append-only.
