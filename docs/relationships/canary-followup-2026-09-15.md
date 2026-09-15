# Canary follow-up, 2026-09-15 — nine defects, reproduced and repaired

The supervised production canary of 2026-09-15 (follow campaign
`webmasterid-auto-300`, 20/20 in one delivery; unfollow dry run
`Unfollow dry-run canary 2026-09-15`, 20 profiles, zero deletes; one
manual unfollow) surfaced nine defects. Each was **reproduced against
the code at `45d14d6` before anything was changed**; the reproduction
is the negative control the fix is measured against.

Nothing here touched production: no migration applied, no campaign
activated, no follow or unfollow performed, nothing merged or deployed.

## The defects

| # | Defect | Root cause at `45d14d6` | Negative control (before) | Fix |
| --- | --- | --- | --- | --- |
| 1 | Confirmation asked for `@handle`, enabled only for `@@handle` | `_confirm-activation.tsx` compared `typed.replace(/^@/,"")` with `facts.actorHandle` as stored; `growth_accounts.handle` keeps the operator's own `@` (seed: `@webmasterid.bsky.social`); the server compared against the session's bare handle — two normalisations | `confirm-handle.test.ts` "THE OLD EXPRESSION": the displayed value fails, `@@` passes | one canonical function, `confirmationHandleMatches`, on both sides; zero or one `@`; case; ASCII-only; full handle grammar; 26 acceptance/rejection cases |
| 2 | Dialog showed 09:00–20:00 UTC for a 00:00–01:00 UTC campaign | `_unfollow-wizard.tsx` built the dialog from React state (`windowLabel: \`${windowStart}–${windowEnd}\``), not the row | `activation-facts.pg.test.ts`: the row says 00:00–01:00 and the loader now says the same; before, the wizard's literal had no path to the row | facts loaded from the persisted row and frozen queue with a version fingerprint; activation reloads and refuses on drift, naming what moved; DST tests (fall back, spring forward, non-UTC) |
| 3 | `/relationships/unfollow/<id>` "was a setup wizard with defaults" | the "View campaign" links (panel and picker) sent unfollow campaigns to `/relationships/campaigns?campaign=<id>`; `loadCampaigns` had no kind filter and rendered the follow detail plus `CreateCampaignForm` beneath an unfollow row | `identity-automation.pg.test.ts`: `loadCampaigns` returned the unfollow campaign as `selected` (before), redirects now | kind-aware loader with `redirectTo`; a complete dashboard view (`_detail-view.tsx`) with no inputs |
| 4 | Unfollow campaign under "Follow campaigns" | one list, one heading, no `kind` on entries; sidebar label | `ia-contract.test.ts` | "Campaigns" with a kind badge on every entry, a filter per kind, unfollow entries link to their own screen, empty states name both |
| 5 | Relationships card showed one campaign while two were active | `loadCampaignSummary` picked the single most live campaign in the workspace, unscoped by identity | `identity-automation.pg.test.ts` "shows two follow campaigns AND an unfollow campaign" | `loadIdentityAutomation`: every active / rate-limited / reauth campaign of both kinds for the selected identity, each with kind, progress, today's counts, both quotas, next run and link; the shared 1,000 ceiling stated once; workspace-scoped |
| 6 | One chunk per delivery; nothing guaranteed the next delivery served anyone else | the tick ran follow with the whole 240 s budget then unfollow with the remainder; `listDueCampaigns` ordered by `next_run_at`; a campaign ran chunk after chunk; no persisted order | `dispatch-round.pg.test.ts` "NEGATIVE CONTROL — the previous shape": the real dispatchers in the old route shape starve F2, F3 and U1 over four deliveries | `dispatchFairly`: rounds, one chunk per campaign per round, order by persisted `last_dispatched_at`; follow priority as a quota rule at claim time; conservative deadline (55 s default, `BLUESKY_TICK_BUDGET_MS`), never claims without time to settle |
| 7 | Silently lost/skipped members | (carried from the 09-14 change) closed reason codes, bounded backoff, conservation, 100k proof | `incident-scale.pg.test.ts` (100k, all faults), `scale-and-import.pg.test.ts` (100k import, concurrent builders) | detail screen shows every category with the reason; unknown shapes stay fail-closed |
| 8 | Three actions "needing reconciliation", no workflow | no read-only path; campaign reconciliation only ran inside a normal pass | `reconcile-now.pg.test.ts` | "Reconcile now" for both campaign kinds (dispatcher in `reconcileOnly`: zero reserved units, no permit can issue) and for manual actions (`reconcileUnresolvedActions`, no path to a mutation); per-action report: profile, operation, observation, timestamp, classification |
| 9 | Dry-run rows read as "skipped" | correct status, misleading label; no count of their own | `detail-and-dry-run.pg.test.ts` | "Simulated (dry run)" on every row, a `simulated` count apart from skips, zero DELETE and zero quota proven, later real campaign unaffected |

## Existing tests that passed for the wrong reason

- `unfollow/confirmation.test.ts` asserted that `handleMatches` and
  `actual !== confirmedIdentity` EXIST in the source. Both did. Neither
  assertion could see that the two sides normalised differently, so the
  suite was green while the displayed value could not pass. It now
  asserts both sides call the same function and that no inline `@`
  stripping remains.
- `setup-flow.test.ts` › "the campaign status panel" pinned the fields
  of a ONE-campaign panel. It passed while a second active campaign was
  invisible. It now asserts the panel maps over every live campaign and
  states the shared ceiling.
- The follow dispatcher tests that exercise `TICK_BUDGET_MS = 240_000`
  pass on any runtime: nothing in them knows the platform's ceiling.
  The deadline is now chosen from evidence-or-conservative and the
  round tests drive an injected clock.
- `render-qa` (browser sweep) never rendered the detail page, the
  campaigns picker or the status panel. Its first run over them found
  a 30 px page overflow at 320 (the panel heading's unbreakable handle)
  and four controls under 44 px — including the follow page's own
  picker entries at 34 px, which had shipped.

## Evidence

Real PostgreSQL throughout: PGlite for the scenario suites, embedded
PostgreSQL (real backends) for fairness, reconciliation concurrency,
grants/RLS with a genuine non-superuser login role, and the 100k
regression.

| Suite | What it proves | Count |
| --- | --- | --- |
| `confirm-handle.test.ts` | the displayed value is accepted; `@@`, lookalikes, substrings, whitespace, case tricks refused | 26 |
| `activation-facts.pg.test.ts` | facts from the row; every consent fact moves the version; DST (fall back, spring forward), Asia/Kolkata; workspace scope | 15 |
| `unfollow/confirmation.test.ts` | one normalisation on both sides; fingerprint sent and compared to the database | 23 |
| `dispatch-round.pg.test.ts` (embedded PG) | rotation across deliveries; the old shape starves; ordering; quota-priority yield; deadline refusals; abandoned invocation; two concurrent deliveries | 9 |
| `reconcile-now.pg.test.ts` (embedded PG) | zero mutations, zero quota, window ignored, backoff kept, completion refused, kill switch stops a read, two workers work each member once | 7 |
| `detail-and-dry-run.pg.test.ts` | dry run: 0 DELETE, 0 quota, simulated, later real campaign unaffected; every detail fact; keyset paging (120 members, 12 runs) | 5 |
| `identity-automation.pg.test.ts` | all live campaigns per identity, both kinds; other identity; other workspace; kind filter and redirect | 4 |
| `ia-contract.test.ts` | never a follow label on an unfollow campaign; no wizard on the detail route; every required section; controls gated | 18 |
| `grants-and-rls-real-session.pg.test.ts` (embedded PG, login role) | 17 worker RPCs service_role-only (every overload); pinned executable set; RLS across workspaces; forged dispatch order refused; migration idempotent | 25 |
| Existing relationship/campaign suites, updated | | 172 |

Browser (Chromium, real compiled stylesheet, hostile content, dialog
forced open): 320 / 375 / 390 / 768 / 1280 — page overflow **0**,
escaping elements **0**, 53 controls all **≥ 44 × 44** at every width.
Procedure and limits: `unfollow-browser-qa.md`.

Mutation controls: see the PR description — each fix reverted in
isolation on the final code fails its intended test.

## Not verified

- The Vercel plan and function ceiling of the Signal project: the
  connector could see only two unrelated projects in one (Pro) team,
  and the repository holds no `.vercel/project.json`. The deadline
  default assumes 60 s; `BLUESKY_TICK_BUDGET_MS` raises it once the
  plan is confirmed.
- No live Follow, Unfollow, activation, migration or deploy was
  performed. The supervised steps are in `production-runbook.md`.
