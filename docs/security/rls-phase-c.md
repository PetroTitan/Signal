# RLS — Phase C

Every Phase C table has Row Level Security enabled. Two helper functions in `public` codify membership:

- `public.is_workspace_member(workspace_id)` — `SECURITY DEFINER`, stable. Returns true if `auth.uid()` is a row in `workspace_members` for the given workspace.
- `public.is_workspace_owner(workspace_id)` — same shape, restricted to `role = 'owner'`.

Policies use these helpers exclusively. No policy reads from any other table directly. No policy depends on the service role.

## Policy matrix

| Table | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| `workspaces` | members | `auth.uid() = created_by` | owners | owners |
| `workspace_members` | own row OR fellow members | self-insert OR owner-insert | owners | owners |
| `products` | members | members | members | members |
| `growth_accounts` | members | members | members | members |
| `workspace_settings` | members | members | members | (no policy) |
| `activity_events` | members | members (actor must be self) | (no policy) | (no policy) |

`activity_events` is append-only by design — there is intentionally no update / delete policy. Past events are not editable from the application.

## Bootstrap correctness

The workspace-create flow runs three RLS-respecting inserts in order:

1. `workspaces` insert with `created_by = auth.uid()`. Policy: anyone-can-create-with-self.
2. `workspace_members` insert with `user_id = auth.uid()` and `role = 'owner'`. Policy: self-insert allowed.
3. `workspace_settings` insert with the new `workspace_id`. Policy: members-can-insert. The previous step made the user a member, so this passes.

All three statements run under the user's session. There is no service-role escape hatch.

## What this prevents

- Cross-workspace reads: a member of workspace A cannot read products / accounts / settings / activity from workspace B.
- Identity spoofing on activity events: `actor_user_id` must equal `auth.uid()` (or be null for system events).
- Unauthorized membership changes: only owners can add or remove other members.
- Privilege escalation: there is no public read on any table.

## Audit checklist

When adding a new table in Phase D or beyond:

1. Enable RLS in the schema migration.
2. Add a SELECT policy gated by `is_workspace_member()`.
3. Add an INSERT policy gated by `is_workspace_member()` plus any actor checks.
4. Add UPDATE / DELETE policies only if the table is mutable from the app.
5. Run the access-denial test: try every operation with a session that is not a member.

## See also

- [../database/phase-c-migrations.md](../database/phase-c-migrations.md)
- [../database/rls-security-plan.md](../database/rls-security-plan.md)
