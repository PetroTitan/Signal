# LinkedIn Sales workspace — runbook

How to deploy, operate and stop the LinkedIn Sales workspace. It prepares
manual tasks; it performs no LinkedIn action. Nothing in this runbook
connects to LinkedIn.

## Deployment order

1. **Review the PR.** The migrations, the RLS tests and the capability
   registry are the compliance boundary; read them first.
2. **Apply the migrations** in order, on a staging project first:
   - `20260917000001_linkedin_sales_workspace.sql` — tables, RLS, functions
   - `20260917000003_linkedin_compliance_tools.sql` — suppression, deletion,
     purge, export
   - `20260917000005_linkedin_import_chunk.sql` — atomic import chunk
     (independent of the compliance functions; its original `…000002`
     prefix collided with the identity-session migration and was never
     executable by a timestamp-based migration runner)
   They are forward-only and additive; no existing table changes.
3. **Verify on staging** (see "After the migration").
4. **Deploy the application.** The `/api/linkedin/tick` cron entry in
   `vercel.json` (every 15 minutes) becomes active with the deploy. It is
   gated by `CRON_SECRET` like every other cron route.
5. **Set `LINKEDIN_SALES_DISABLED=1` first** if you want the routes live but
   no tasks prepared until an operator has looked at a workspace; unset it
   to start preparing.
6. Nothing else to configure. `SUPABASE_SERVICE_ROLE_KEY` is already
   required by the publishing scheduler; the LinkedIn tick uses the same
   key and returns 503 without it.

Do not connect a LinkedIn account to test this feature; it does not need
one. The existing LinkedIn OAuth (sign-in scopes) is unchanged.

The `…000005` import migration intentionally sorts after `…000003`. Both
depend only on the tables in `…000001`; neither depends on functions from
the other migration. Do not restore the old `…000002` filename: that
version is already owned by `identity_session_coordinator`.

## After the migration — what to verify

Run as a genuine non-superuser role (the tests do; do the same by hand on
staging with `set role authenticated` and a JWT claim):

- A viewer can read every `linkedin_*` table in their workspace and write
  none of them.
- An editor cannot `insert` into `linkedin_manual_tasks` (only the release
  function may).
- `service_role` may call `release_linkedin_campaign_tasks` and may not
  call `confirm_linkedin_task`, `skip_linkedin_task`,
  `suppress_linkedin_lead_from_task` or any of the five compliance tools.
- `update`/`delete` on `linkedin_compliance_events` raise for everyone.

Then, as an operator: create a list, import three URLs, build a two-step
sequence, start a campaign with a window that includes now, call the tick
with the cron secret, and see three tasks. Open one, copy the draft, and
confirm that the member is still `waiting` at position 1 until you click
**Mark completed**.

## Operating

- **Working window and daily target** are per campaign. The target is the
  number of tasks Signal prepares per local day; it is a workload setting
  for the operator, not a LinkedIn limit, and the product never describes
  it as one.
- **Pause** stops preparation; open tasks stay open. **Resume** keeps the
  frozen membership. **Cancel** cancels open tasks and waiting people and
  keeps history.
- **Suppression list** (`/linkedin/compliance`): adding a person ends their
  waiting steps and cancels their open tasks in every campaign, and marks
  every lead row do-not-contact. Removing an entry makes them contactable
  for FUTURE campaigns only; ended memberships stay ended.
- **Deletion request**: deletes every lead row, membership and task for
  the profile; the key stays on the suppression list as
  `deletion_request` so an import cannot bring the person back. The audit
  event stores a hash of the key, not the key.
- **Retention purge**: deletes leads past their `retention_until`, 500 per
  run; run it until "remaining" is zero. It is a button, not a cron, so a
  person decides.
- **Export**: JSON of every row held about one profile, from
  `/api/linkedin/profile-export?profile=<url>`; recorded in the audit
  history.

## Stopping it

- `LINKEDIN_SALES_DISABLED=1` on the deployment stops every workspace from
  getting new tasks at the next tick. Checked before any database read.
- Pause or cancel a single campaign from `/linkedin/campaigns`.
- Removing the cron entry stops preparation entirely; nothing else runs
  in the background.

There is no LinkedIn session, token or browser to revoke, because none
exists.

## Incident notes

- **Tasks not appearing**: check the tick response (`deferred` reasons:
  `outside_window`, `daily_target_reached`, `invalid_timezone`,
  `deadline`), then `linkedin_campaign_conservation` for the campaign —
  every member is in exactly one of six states and the counts add up.
- **A member is `structurally_invalid`**: the `state_reason` names the
  problem (`sequence_position_gap`, `email_integration_unavailable`,
  `unknown_step_kind:<kind>`). Fix the sequence and start a new campaign;
  terminal states are final by design.
- **An import shows "In progress"**: send the same file again; the job
  resumes from its cursor. A "Failed" job shows `last_error` and also
  resumes on re-send.
- **Someone asks to be forgotten**: use the deletion tool; then confirm
  via export that only the suppression entry remains.

## What the audit history is

`linkedin_compliance_events` is append-only (a trigger raises on update
and delete, for every role including the table owner). It records who
imported, confirmed, skipped, opened, copied, suppressed, exported,
deleted, started, paused, resumed, cancelled and purged. It is the record
of operator statements; it is not evidence of what happened on LinkedIn,
which Signal cannot observe.
