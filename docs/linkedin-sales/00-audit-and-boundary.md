# LinkedIn Sales Workspace — audit, product boundary, architecture, threat model

Baseline: `origin/main` at `946019c` (PR #197 merged). Written before any
implementation, as the brief requires. Nothing in this document was
done against production, a live LinkedIn account, or LinkedIn's site.

## 1. Official sources — accessed 2026-09-15

Each was fetched and read on 2026-09-15. Conclusions, not quotations;
section numbers where the document has them.

| Source | Conclusion that binds this design |
| --- | --- |
| Prohibited Software and Extensions (help a1341387) | Prohibited categories include crawlers, browser plugins and add-ons that scrape; bots or other unauthorized automated methods to access the service; tools that add or download contacts or **send or redirect messages**; software that creates, comments on, likes, shares or re-shares posts; inauthentic engagement; overlays that modify the site; search tools, aggregators and brokers; anything that bypasses security features or access/use limits. Consequence: account restriction or shutdown. |
| User Agreement, §8.2 "Don'ts" and §2.2 | 8.2.2 no software, scripts, robots, crawlers, plugins or add-ons to scrape or copy the service; 8.2.3 no overriding security or bypassing access controls and usage limits; 8.2.4 no copying or distributing information without consent; 8.2.13 no bots or other unauthorized automated methods to access the service, **add or download contacts, send or redirect messages**, create, comment on, like, share or re-share posts. §2.2 members must keep their password confidential and must not share or transfer their account. |
| Crawling Terms | Crawling requires LinkedIn's express, whitelisted permission and is limited to search indexing unless separately approved; masking IP or user-agent is prohibited; harvesting member profiles is prohibited; permission is revocable; violations bring immediate ban and possible legal action. |
| API Terms of Use | 3.1(24) no scraping, crawling or any software to reach content outside the APIs; 3.1(26) no automating posting; 3.1(23) no accessing members' connection networks without express permission; 3.1(20) no exceeding or circumventing API limits; 3.1(8) no selling, sharing or distributing Content; 4.1/4.3/4.4/4.5 Content storage only in permitted cases, with identification and selective deletion, legally valid consent for Profile Data, deletion on request and on termination; 5.2 consent requirements. |
| Marketing API Program (Microsoft Learn) | Documented products: Advertising, Event Management, Community Management (organization pages), Lead Sync (Lead Gen Forms), Matched Audiences, Audience Insights, Media Planning, Conversions, Company Intelligence. All require program access. **No documented API sends messages or connection requests, views or searches member profiles, or performs engagement on behalf of a member.** |

**What follows from the sources, regardless of the brief:**

1. Every outreach and member action — connection request, message,
   InMail, like, follow, unfollow, endorsement, profile view, comment —
   is a member action LinkedIn does not expose through any documented
   API. Signal can only prepare work for a human. These capabilities
   are `manual_only` and cannot be promoted to `official_api_approved`
   by configuration: promotion requires a documented product, a
   granted scope and an adapter, and none exists.
2. Collecting profile data by any means other than the customer typing
   or uploading it is scraping under 8.2.2 / 3.1(24). Signal must not
   request a profile URL, even to "verify" it.
3. Credentials, cookies and session tokens are the member's (§2.2).
   Signal must not have fields, code paths or UI for them.
4. `openid` / `profile` / `email` scopes identify a person. They confer
   no permission to message, connect, read a network, or post. The
   existing LinkedIn OAuth connection in Signal (identity only) must
   not be read as permission for anything in this product.
5. The brief's allowance "use official LinkedIn APIs only for
   capabilities explicitly approved" is narrower in practice than it
   reads: for this product there are no such capabilities today. The
   design follows the stricter official position and records this
   divergence.

## 2. Repository audit

### 2.1 Authorization and session

- `getPrimaryWorkspace()` (`src/repositories/workspace-repository.ts`)
  resolves the signed-in user's workspace from the cookie session;
  every page and action starts there.
- `can(role, permission)` (`src/core/teams/permissions.ts`) is the pure
  role→permission matrix. Roles: owner > admin > editor > reviewer >
  viewer. `edit_content` is editor+; `connect_platforms` /
  `manage_settings` / `manage_members` are admin+; viewer has
  `view_content` only.
- Server actions establish a context first (`requireCtx()` /
  `requireCampaignContext()` / `requireRelationshipContext()`), never
  trust a client-sent workspace id, and are pinned by source contracts
  (`authorization.test.ts`, `rls-and-authorization.test.ts`).
- Activity: `recordActivity()` inserts `activity_events` (workspace,
  actor, event_type, entity, title, description, metadata).

**Reused as-is.** The LinkedIn product adds a `linkedin_sales`-scoped
context helper following the same shape, and uses `edit_content` for
create/modify and confirmation (see §5).

### 2.2 Identities and connections

- `growth_accounts` (workspace_id, platform, handle, display_name,
  status, connection_status) and `platform_connections` (platform in
  reddit/x/linkedin/bluesky…, provider_account_id, scopes text[],
  encrypted access/refresh tokens, expires_at).
- LinkedIn OAuth exists (`docs/oauth/linkedin-oauth.md`,
  `/api/oauth/[platform]/*`) and requests **`openid` and `profile`
  only**. Publishing scopes were explicitly deferred "under a separate
  approval gate". Disconnect is local.

**Reused for display only.** The LinkedIn Sales product shows whether a
LinkedIn identity is connected, so the operator knows which account
they will act as in their own browser. It reads no token, calls no
LinkedIn endpoint, and treats the connection as identity, not
permission. The `scopes` column is what the capability registry checks
if a capability were ever `official_api_approved`; none is.

### 2.3 Bluesky campaign primitives — reusable vs. forbidden

| Primitive | Reuse? | Why |
| --- | --- | --- |
| Workspace context, `can()`, `recordActivity` | **Yes** | tenant and role model |
| RLS helper pattern (`is_workspace_member`, role-gated `can_manage_*` SECURITY DEFINER helpers) | **Yes** (new helper `can_edit_linkedin_sales`) | same policy shape |
| Composite ownership `(workspace_id, id)` uniques + composite FKs | **Yes** | tenant integrity in the database |
| Guarded state transitions (`update … where state in (…)`), `on conflict do nothing` idempotency, `for update skip locked` | **Yes** (pattern) | at-least-once cron safety |
| Keyset pagination (`import_sequence`, `local_date`), no OFFSET | **Yes** (pattern) | large lists |
| Local-day / window / DST helpers (`campaign-day.ts`) | **Yes** | campaign timezone and working window |
| Fair round-robin with persisted `last_dispatched_at` (`dispatch-round.server.ts`) | **Yes** (pattern) | multiple campaigns in one workspace |
| Cron auth (`authorizeCronRequest`), deploy kill switch env pattern | **Yes** | scheduler route |
| Real-PostgreSQL harnesses (PGlite + embedded server), supabase adapter, prelude roles | **Yes** | RLS with a genuine login role |
| Route manifest + guard, TrustPanel, design system, render-QA sweep | **Yes** | navigation and accessibility |
| AI provider abstraction (`ai-provider.ts`, allowed use-case registry, `quickSafetyCheck`) | **Yes** (new use case) | draft assistance under the existing policy |
| Bluesky **workers** (`worker.server.ts`), `execute-actions.server.ts`, atproto client | **No** | they perform provider mutations; LinkedIn execution is manual-only |
| Session resolver / refresh (`session.server.ts`) | **No** | there is no LinkedIn session to act with |
| Quota reservation RPCs, mutation permits (`reserve_bluesky_campaign_quota`, `consume_bluesky_member_quota`), identity daily ceilings, rate-limit states | **No** | a "safe action limit" against LinkedIn must not exist; the daily task target plans human work, it is not a provider budget |
| Reconciliation-by-read, `provider_in_flight`, `reconciliation_required` | **No** | Signal never sends, so there is nothing to reconcile with the provider; the operator's confirmation is the only outcome |
| Identity kill switches ("Stop this identity") | **No** (campaign pause/cancel instead) | a switch keyed on the provider identity implies Signal acts as it |

### 2.4 Scheduler and execution claims

`publishing-scheduler.ts` claims execution items atomically
(`scheduled → running`) before any provider call; the Bluesky
dispatcher claims members under reservations and a per-run dispatch
lease. The LinkedIn scheduler reuses the *claim-before-work* shape but
the "work" is inserting internal task rows; there is no provider call
to guard.

### 2.5 Existing LinkedIn claims — findings

1. **`src/app/(marketing)/page.tsx:67`** lists LinkedIn with
   `publishing: "Automated"`. This is false: `publishToLinkedIn` returns
   `not_implemented`, `SCHEDULER_AUTONOMOUS_PLATFORMS` excludes
   linkedin (P0.3), and `platform-capability-truth.test.ts` asserts it.
   The marketing copy is corrected in this change to
   "Manual distribution (no automated publishing)" — a truthfulness
   fix, not a product change; the code already behaves that way.
2. `src/core/mcp-operations/operation-policy.ts` and
   `docs/mcp/mcp-operations-policy.md` already forbid logging into
   Reddit / X / LinkedIn through any browser-automation path.
   Consistent with this brief.
3. `docs/oauth/linkedin-oauth.md` records the intent to add publishing
   scopes "under a separate approval gate". Not implemented; not
   touched.
4. No code in the repository collects LinkedIn cookies, passwords or
   session tokens, and no browser-automation dependency exists
   (`package.json`: no playwright/puppeteer). The negative-control
   tests in this change make that a maintained property.

### 2.6 Email

`createEmailSender()` is a documented no-op: **there is no email
provider in this codebase.** The `authorized_email` step kind is part
of the closed set for the schema, but a sequence containing one cannot
be activated in this release: the capability registry marks
`email_outreach` as `unavailable`, activation refuses with that reason,
and no email is ever sent. Unsubscribe/suppression enforcement for
email is specified in the registry entry and will be a precondition
for turning it on.

### 2.7 Conflicts with the brief

None that require stopping. Two divergences are recorded:

- The brief permits official-API capabilities where approved; no such
  capability exists for outreach. The registry therefore contains no
  `official_api_approved` entry and no LinkedIn HTTP adapter (§1.5).
- The brief lists `authorized_email` as an allowed step kind; without
  an email integration it is schema-only and blocked at activation (§2.6).

## 3. Product boundary

Signal prepares, schedules and records **manual LinkedIn tasks**. It
never performs a LinkedIn member action, never reads LinkedIn, and
never holds anything that could log in as the member.

Truthful vocabulary, enforced by a copy contract test:

| Say | Never say |
| --- | --- |
| Prepare task | Send automatically |
| Open in LinkedIn | Execute |
| Copied | Sent |
| Operator confirmed | Provider confirmed |
| Manual LinkedIn task | Automated LinkedIn action |
| Daily task target (how many tasks Signal prepares for people) | Safe daily limit |

Four separate events, never inferred from one another: **opened**
(operator opened the public profile in a new tab), **copied** (operator
copied the draft), **operator confirmed** (operator states they did it),
**skipped** (operator chose not to, with a reason). A task is completed
only by `operator_confirmed`.

Every `/linkedin` page carries the persistent notice: *Signal prepares
and schedules this work. It does not perform LinkedIn actions on your
behalf: you open the profile, you decide, you act on LinkedIn, and you
confirm here.*

## 4. Domain model

Tables (all with `workspace_id`, `unique (workspace_id, id)`; child rows
reference parents with composite `(workspace_id, parent_id)` foreign
keys so a row can never reference another workspace's parent):

- `linkedin_lead_lists` — name, `source_type` (closed:
  `customer_csv | customer_pasted | internal_api`), `source_note`,
  `status` (`active | archived`), `created_by`.
- `linkedin_leads` — `lead_list_id`, `canonical_profile_url`,
  `profile_key` (normalised slug), customer-provided name/company/title,
  `source_type`, `source_reference`, `processing_basis_note`,
  `do_not_contact`, `retention_until`. Unique per (workspace, list,
  profile_key). Nothing else about the person is stored.
- `linkedin_suppression_entries` — workspace-global, unique per
  (workspace, profile_key), with `reason` and `source`.
- `linkedin_sequences` / `linkedin_sequence_steps` — steps are a closed
  set: `manual_connection_request | manual_linkedin_message |
  manual_profile_review | wait | internal_note | authorized_email`;
  `position` unique per sequence; `wait_days ≥ 0`; `template`;
  `required_confirmation`.
- `linkedin_campaigns` — `lead_list_id`, `sequence_id`, `status`
  (`draft | active | paused | completed | cancelled`), `timezone`,
  working window, `daily_task_target` (1–200), `membership_frozen_at`,
  `last_dispatched_at`, lifecycle timestamps.
- `linkedin_campaign_members` — one per (campaign, lead); `state`
  (closed: `waiting | completed | suppressed | operator_skipped |
  structurally_invalid | cancelled`), `state_reason`, `current_position`,
  `next_step_available_at`. Membership is frozen at activation.
- `linkedin_manual_tasks` — one per (member, step) by unique index;
  `state` (closed: `scheduled | ready | opened | copied |
  operator_confirmed | skipped | cancelled`); `kind` copied from the
  step; `draft_text`, `profile_url`, `local_date`, `available_at`,
  `opened_at`, `copied_at`, `operator_confirmed_at`,
  `operator_confirmed_by`, `skip_reason`. CHECKs tie each timestamp to
  its state. Only the scheduler function inserts tasks.
- `linkedin_import_jobs` — durable import cursor (`cursor_row`), counts
  (inserted / duplicate / invalid / suppressed), bounded error report.
- `linkedin_compliance_events` — append-only (trigger refuses update
  and delete): import, suppression, export, deletion, operator
  confirmation, skip, activation, cancellation.

State machines and the scheduler are specified in
`01-architecture.md`.

## 5. Security model

- RLS on every table. Members of the workspace may read. Insert /
  update / delete on lists, leads, sequences, campaigns, members and
  suppression require `can_edit_linkedin_sales(workspace_id)` — owner,
  admin or editor, mirroring `edit_content`. Reviewer and viewer read
  only. Confirming, skipping or suppressing from a task is an edit.
- `linkedin_manual_tasks`: members may read; editors may update state
  (the guarded transitions live in the repository and are also
  constrained by CHECKs); **no insert policy for authenticated** — only
  the scheduler function (SECURITY DEFINER, service_role-only EXECUTE)
  creates tasks, so a task can only ever come from a sequence step.
- `linkedin_compliance_events`: members may insert and read; no update
  or delete policy and a trigger that raises on both, for every role
  including service_role.
- service_role is used for exactly one thing: the cron-driven task
  release. There is no LinkedIn HTTP client anywhere for it to call.
- Composite foreign keys, unique constraints and CHECK constraints
  carry tenant integrity independently of RLS and of application
  filters.

## 6. Threat model

| Threat | Control |
| --- | --- |
| Operator (or a future contributor) turns Signal into an automation tool | No LinkedIn HTTP client, no browser-automation dependency, no credential fields; structural negative-control tests fail the suite if any is introduced; the capability registry fails closed |
| Cross-tenant read or write | RLS on every table with a genuine login-role test; composite FKs refuse a parent in another workspace; unique keys are workspace-scoped |
| Forged task completion | `operator_confirmed` requires an editor session and an explicit action; the row records who and when; CHECKs prevent a confirmed timestamp on any other state |
| Inferred completion from opening/copying | separate columns and states; a test asserts opening and copying never change the outcome |
| Scraping "just to validate a URL" | the importer validates URL shape only; no fetch; a negative-control test scans the import and lead code for network calls |
| Duplicate tasks on cron replay | unique (member, step); release is one atomic function; re-entry inserts nothing new |
| Suppressed lead contacted | suppression is checked at import, at activation and at every release; a member for a suppressed lead is `suppressed`, never `waiting` |
| Data creep | leads carry only URL, key, three customer-provided fields, source and basis; no AI inference of protected characteristics — the draft prompt receives only those fields and the safety check runs on the output |
| Retention | `retention_until` per lead; a compliance-page action deletes expired leads and records the deletion |
| service_role misuse | EXECUTE on the release function only; the function inserts internal rows and nothing else |

## 7. What this release does not do

No scraping, crawling, profile fetching or metadata lookup; no browser
automation of any kind; no LinkedIn cookies, passwords or session
tokens; no automatic connection requests, messages, InMails, likes,
follows, unfollows, endorsements, profile views or comments; no
undocumented endpoints; no LinkedIn API call at all; no email sending
(no provider exists); no proxies, fingerprinting or behaviour
simulation; no "safe limit" claims.
