# LinkedIn Sales Workspace — architecture

Companion to `00-audit-and-boundary.md`. Describes what is built, how
work flows, and the exact state machines.

## 1. Information architecture

| Route | Purpose |
| --- | --- |
| `/linkedin` | dashboard: leads, suppressed/invalid, active campaigns, tasks ready today, awaiting confirmation, completed/skipped/cancelled, capability status |
| `/linkedin/leads` | lead lists, import (CSV / pasted URLs), leads by keyset, retention |
| `/linkedin/sequences` | sequences and their steps (closed kinds) |
| `/linkedin/campaigns` | campaigns: create, activate (freezes membership), pause, resume, cancel future work; member states |
| `/linkedin/tasks` | today's manual tasks as cards: customer-provided lead facts, profile URL, draft, Copy draft, Open in LinkedIn, Mark completed, Skip with reason, Add to suppression list |
| `/linkedin/analytics` | counts and outcomes over time |
| `/linkedin/compliance` | capability registry, suppression list, compliance events, retention and deletion, export |

All seven are registered in the route manifest; `/linkedin` is
`secondary` (More sheet + sidebar), the rest `contextual`, reached from
`/linkedin`. A shared layout renders the boundary notice on every page.

## 2. Flow

```
import (CSV / pasted / internal API)
   └─ normalise URL → profile_key → suppression check → insert (idempotent) → counts + error report
create sequence (closed step kinds)
create campaign (list + sequence + tz + window + daily target)
activate  ─────────────► membership FROZEN: one member per lead
                          suppressed / do_not_contact → member.suppressed
                          otherwise → member.waiting, position 0
cron tick (service_role) ► release_linkedin_campaign_tasks(...)
   per active campaign, fair order, up to daily_task_target per local day:
   for each waiting member whose next step is due:
     wait step        → advance position, schedule next availability (no task)
     authorized_email → refused at activation; never reached
     other kinds      → insert task (unique per member+step) as ready/scheduled
operator (editor+) on /linkedin/tasks:
   Open in LinkedIn → opened_at            (records; changes nothing else)
   Copy draft       → copied_at            (records; changes nothing else)
   Mark completed   → operator_confirmed   (explicit; member advances)
   Skip with reason → skipped              (member → operator_skipped)
   Add to suppression → suppression entry + task cancelled + member suppressed
next tick releases the member's next step when available_at ≤ now
last step confirmed → member.completed; all members terminal → campaign.completed
```

## 3. State machines

### Campaign

`draft → active → (paused ⇄ active) → completed | cancelled`

- `activate` only from `draft` (or `paused` to resume); freezes
  membership on the first activation.
- `cancel` from `active` or `paused`: tasks not terminal → `cancelled`;
  members `waiting` → `cancelled`; completed history preserved.
- `completed` is set by the scheduler when no member is `waiting` and no
  task is non-terminal.

### Member

`waiting → completed | operator_skipped | suppressed | cancelled | structurally_invalid`

- `structurally_invalid`: the lead's URL fails the current normaliser
  (data written before a stricter rule) or the step kind is unknown to
  the scheduler — fail closed, visible, with `state_reason`.
- `state_reason` is always set for a terminal state other than
  `completed`.

### Task

```
scheduled → ready → opened → copied → operator_confirmed
                 ↘ (from ready/opened/copied) skipped
                 ↘ (any non-terminal) cancelled
```

- `opened` and `copied` are optional recordings on the way; the
  operator may confirm from `ready`, `opened` or `copied`.
- `operator_confirmed` requires an explicit action by an editor+;
  it records `operator_confirmed_by` and `operator_confirmed_at`.
- CHECK constraints: `operator_confirmed_at is not null` iff
  `state = 'operator_confirmed'`; `skip_reason is not null` iff
  `state = 'skipped'`; `opened_at`/`copied_at` may only be set when the
  state is at least the corresponding step.
- One non-terminal task per member at a time (partial unique index);
  one task per (member, step) ever (unique index).

## 4. Scheduler

`releaseLinkedInTasks({ db, nowIso })` — service_role, cron-driven,
at-least-once safe:

1. List active campaigns (limit 50), ordered by `last_dispatched_at`
   nulls first (fair rotation across campaigns, persisted).
2. For each campaign in rotation: compute the campaign's local date and
   whether the working window contains now; if not, skip. Count tasks
   released for that local date; the remaining budget is
   `daily_task_target − released`.
3. Call `release_linkedin_campaign_tasks(workspace, campaign, local_date,
   now, limit)` — one SQL function: selects due `waiting` members by
   `(next_step_available_at, id)` keyset `for update skip locked`,
   advances through `wait` steps, marks members whose lead is now
   suppressed as `suppressed`, inserts tasks with
   `on conflict do nothing`, returns counts. A crash before the function
   commits changes nothing; a replay after it inserts nothing.
4. Touch `last_dispatched_at` before the call; loop rounds while any
   campaign released something.
5. Promote `scheduled → ready` for tasks whose `available_at ≤ now`.
6. Complete campaigns with nothing left.

The daily target counts **tasks prepared**, never LinkedIn actions, and
the UI says so.

## 5. Capability registry

`src/core/linkedin-sales/capabilities.ts` — one table of every LinkedIn
capability the product could conceivably touch, each with `status`
(`unavailable | manual_only | official_api_approved`), required
product/scopes, evidence reference, last verified date, adapter and
user-facing explanation. Every outreach/member action is `manual_only`;
identity display via existing OAuth is `official_api_approved` for
`identity_display` only (scopes `openid`, `profile`). A guard
`assertLinkedInApiUse(capability, grantedScopes)` throws unless the
capability is `official_api_approved`, has an adapter, and every
required scope is granted. No caller exists for any outreach
capability, and a negative-control test asserts no LinkedIn HTTP client
module exists.

## 6. Import

- Accepts `linkedin.com/in/<slug>` (and `www.`, `http`, mobile `m.`,
  locale subdomains like `uk.`); rejects everything else (companies,
  search, feeds, `pub/`, `sales/`, non-LinkedIn hosts). Strips query,
  fragment, trailing slash, case-folds the slug. `profile_key` =
  `in/<slug>` lower-cased; canonical URL = `https://www.linkedin.com/in/<slug>`.
- CSV: RFC-4180 quoting, BOM, CRLF, empty rows, header detection
  (`url`, `linkedin`, `profile` columns; otherwise first URL-shaped
  cell), optional name/company/title columns. Malformed rows are
  reported, never discarded.
- Limits: 1 MB per upload (Next.js server-action body default) and
  10,000 rows per file; larger files are split by the operator. A
  durable `linkedin_import_jobs` row carries the cursor; a retry
  re-sends the same file with the job id and resumes from `cursor_row`.
- Inserts in chunks of 500 with `on conflict do nothing`; duplicates
  counted by comparing returned rows; suppressed leads are inserted
  with `do_not_contact = true` (so the list is honest about what was
  provided) and can never become `waiting` members.
- Error report: bounded (2,000 rows) on the job, exportable as CSV.

## 7. Accessibility and layout

Semantic `<form>`/`<fieldset>`/`<legend>`; `aria-live` status and error
regions; every control ≥ 44 px; visible focus (`focus-visible` ring
from the design system); status always carries text, never colour
alone; no page-level horizontal overflow at 320–1280 (measured by the
Chromium sweep, not inferred from classes).
