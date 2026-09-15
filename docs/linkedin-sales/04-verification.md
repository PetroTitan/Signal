# Verification record — LinkedIn Sales workspace

What was run, on what, with what result. Date: 2026-09-15.
Baseline `origin/main` 946019c; head: the last commit on
`feat/linkedin-sales-workspace`.

## Gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` (next lint) | no warnings or errors |
| `npm test` (full suite) | 305 files passed, 3 skipped; 5,461 tests passed, 9 skipped; exit 0 (662 s) |
| `npx next build` | compiled; all seven `/linkedin/*` pages and both `/api/linkedin/*` routes present |
| `git diff --check 946019c HEAD` | clean |

## New tests, by file

| File | Backend | Tests | What it proves |
| --- | --- | --- | --- |
| `schema-and-rls.pg.test.ts` | embedded PostgreSQL, genuine login role `linkedin_sales_user` (nosuperuser, nobypassrls) | 19 | roles, cross-workspace isolation, composite FKs, closed kinds, task CHECKs and one-active index, editor cannot insert a task, function privileges, append-only events, service_role grants exactly as declared |
| `import.pg.test.ts` | PGlite, all migrations, through RLS | 10 | counts (inserted/duplicate/invalid/suppressed), suppressed rows recorded do-not-contact, report rows, duplicates across imports, idempotent re-send, stop/resume with a replayed chunk, 10,000 rows with the 2,000-line report cap, limit refusals create no job, viewer and cross-workspace refusals, failed chunk then resume, basis note and retention on every lead |
| `scheduler.pg.test.ts` | PGlite | 15 | daily target with replayed ticks and next local day, window and timezone, two rounds in one instant never double a task and the index refuses a hand-made one, fairness order and persisted rotation, frozen membership, suppression at activation and release, position gap, email step refused, connection → wait → message walk where opening and copying never advance and only confirmation does, skip needs a reason, service role cannot confirm/skip, pause/resume/cancel with conservation, unknown kind fails closed, no OFFSET |
| `compliance.pg.test.ts` | PGlite | 7 | suppression across campaigns with counts, idempotent re-add, lift clears only the flag, waiting member ended and re-import recorded do-not-contact, malformed key and unknown source refused, deletion request leaves only the key with a hashed event, retention purge in batches, export contents, viewer refused and service_role has no execute privilege |
| `state.test.ts` | node | 8 | transition tables, no automatic kind, fail-closed releasable set, truthful labels |
| `profile-url.test.ts` | node | 42 | accepted shapes, refusals incl. credential-like and hostile input, no network |
| `capabilities.test.ts` | node | 9 | registry contents, fail-closed guard, identity scopes are not permission |
| `csv.test.ts` | node | 11 | RFC 4180 accommodations, column detection, 50,000 rows in one pass |
| `mobile-layout.test.ts` | node (class tokens) | 13 | 44px targets incl. non-shrinking glyphs, break classes, tables in `overflow-x-auto`, dialog sizing, fieldsets, live regions, aria-current, labelled sections |
| `truthful-copy.test.ts` | node | 7 | attribution-aware vocabulary guard, five distinct task controls, opening never confirms, attestation required, boundary notice on every page, target described as workload |
| `actions-authorization.test.ts` | node (repository mocked) | 11 | signed-out and viewer/reviewer refused before any repository call, editor/admin/owner pass, attestation/reason/confirmation ticks required, opened/copied never confirm |
| `linkedin-negative-controls.test.ts` | node (reads the repo) | 11 | no browser automation dependency or import, no credential columns/types/fields, only documented LinkedIn URLs, no HTTP client in the LinkedIn code, no automatic-action marker, kind sets agree, publishing scheduler still excludes LinkedIn, scopes are openid+profile and the registry agrees, cron/route/middleware agree |
| `render-qa.test.ts` | node → HTML for the browser | 1 (skipped unless `RENDER_QA=1`) | writes the harness the Chromium sweep measures |

New tests: **163** (+1 harness). Real-PostgreSQL tests among them: 51, on two
backends (embedded server for the RLS suite, PGlite for the rest), every
migration applied as shipped.

## Mutation checks

Each mutation was applied, the focused suite run, the file reverted from
git, and the tree confirmed clean before the next.

| Mutation | Caught by | Failures |
| --- | --- | --- |
| `can_edit_linkedin_sales` → `select true` (no workspace/role check) | schema-and-rls | 4 |
| suppression clause removed from `release_linkedin_campaign_tasks` | scheduler | 1 |
| `recordTaskOpened` sets `operator_confirmed` (completion inferred from open) | scheduler | 1 |
| `isReleasableTaskKind` → `true` and the steps kind CHECK dropped | state, schema-and-rls, negative controls | 6 |
| one-active-task index and (member, step) uniqueness removed | scheduler, schema-and-rls | 13 |
| `sendConnectionRequest` export added and `'automatic_message'` kind added | negative controls, schema-and-rls | 2 |

## Browser and keyboard evidence

See `02-browser-qa.md`: Chromium at 320/375/390/768/1280 — 0 overflow,
0 escaping elements, 57/57 controls ≥ 44 × 44; glyph rows 44px with a
click 200px from the glyph toggling them; Tab reaches every control with
a painted focus indicator; modal inert outside and closes on Escape.

## Limitations of this slice

- **No email sending.** `authorized_email` exists in the closed kind set
  but no email integration is authorized in Signal; activation refuses a
  sequence that contains it and the scheduler fails closed if one slips
  through. Adding one is a separate, separately-authorized piece of work.
- **AI suggestions use the active provider**, which in this repository is
  the local preview provider; the safety check runs on its output. No
  external model was called during this work.
- **No live LinkedIn verification** was performed and none is possible
  from this code: it has no LinkedIn client. What the operator does on
  LinkedIn is outside what Signal can observe, and the product says so.
- **Server pages are not in the render harness** (they need a Supabase
  project); their tables are class-token controlled, not measured.
- **Sequences and lists are not editable after creation** in this slice;
  create a new one. Campaign membership is frozen at activation by design.
- **Retention purge is a button**, not a cron; a person runs it.
- **The RLS suite runs against an embedded PostgreSQL 16**, not a Supabase
  project; Supabase's own roles and `auth.uid()` are recreated by the
  harness prelude. Behaviour on a real project must be verified after
  the migration is applied to staging (see `03-runbook.md`).
