# Measurement runtime audit — production truth after PR #175

Status: current as of the `feat/social-intelligence-production-reliability` milestone.
Baseline audited: `origin/main` @ `837d467` (PR #175 merge commit).
Production inspected: **2026-08-19T19:56Z**, read-only.

This document records what was *observed* in production rather than what
the previous milestone's report *claimed*. Where the two disagree, the
observation wins and the implementation adapts.

---

## 1. Evidence table

| # | Claim | Expected | Observed | Evidence | Verdict | Impact |
|---|---|---|---|---|---|---|
| 1 | PR #175 is merged | merged | merged `2026-08-19T19:43:33Z`, `origin/main` = `837d467` | GitHub API `/pulls/175`; `git log` | ✅ confirmed | branch base is correct |
| 2 | Migration `20260819000001` applied | unknown | **applied** | 6/6 new `post_metrics` columns present | ⚠️ **changed since last report** | migration work is verification, not application |
| 3 | `account_snapshots` exists | unknown | exists, RLS enabled, 3 policies, 2 indexes | `pg_class.relrowsecurity`, `pg_policies`, `pg_indexes` | ✅ confirmed | writer can be built against real schema |
| 4 | `publish_history.mode` widened | 4 values | `CHECK (mode = ANY (ARRAY['api','manual','external','unknown']))` | `pg_get_constraintdef` | ✅ confirmed | reconciliation vocabulary is live |
| 5 | `post_metrics` row count | 0 | **0** | `select count(*)` | ✅ confirmed | still nothing measured |
| 6 | `account_snapshots` row count | 0 | **0** | `select count(*)` | ✅ confirmed | expected — no writer existed |
| 7 | Measurable X publications | 15 | 15 | `publish_history` | ✅ confirmed | unchanged |
| 8 | Measurable Bluesky publications | 13 | 13 | `publish_history` | ✅ confirmed | unchanged |
| 9 | Metrics cron configured | `0 6 * * *` | `0 6 * * *` in `vercel.json` on `main` | `git show origin/main:vercel.json` | ✅ confirmed | schedule intact |
| 10 | Refresh route deployed | yes | `/api/metrics/refresh` → 401 | unauthenticated GET | ✅ confirmed | route exists, secret configured |
| 11 | **New** routes deployed | unknown | `/api/metrics/backfill` GET → **405**, POST → 401; `/account-health` → 307 | unauthenticated probes | ✅ confirmed | PR #175 code IS live |
| 12 | Vercel crons fire at all | unknown | **yes** — every published row has `metadata.source = 'scheduler'`, median lag 141 s behind `scheduled_at` | `publish_history` ⋈ `execution_items` | ✅ confirmed | a `*/5` cron demonstrably runs |
| 13 | `SUPABASE_SERVICE_ROLE_KEY` set in production | unknown | **effectively yes** — the scheduler tick writes `publish_history` and `execution_logs` through the service-role client | publish rows exist with `source='scheduler'` | ⚠️ inferred, not directly read | the 503 hypothesis from the last report is **not** supported |
| 14 | Sweep has ever left a trace | some | **zero** `metrics.*` rows in `activity_events`, ever | `select … where event_type like 'metrics.%'` | ❌ **no trace** | see §2 |
| 15 | Candidates exist for the sweep right now | unknown | **2** (bluesky 08-15 14:25, x 08-15 14:05), both inside the 14-day window | seed-window replica query | ✅ confirmed | the sweep would have work to do |
| 16 | X numeric user ids stored | unknown | **all 3 present** (`2056078504567984128`, `2050724947689967616`, `1265618935753433092`) | `platform_connections.provider_account_id` | ⚠️ **better than reported** | X own-timeline reconciliation is unblocked |
| 17 | Local database validation possible | maybe | **no** — Docker is not available on this machine | `docker info` fails | ❌ blocked | migration chain NOT executed locally; see §4 |

---

## 2. The correction that matters most

The previous milestone's report treated `post_metrics = 0` as an unsolved
mystery pointing at a missing environment variable or a dead cron. Two
observations change that reading:

- **Crons demonstrably fire.** Every published post carries
  `metadata.source = 'scheduler'` and lands a median 141 seconds after its
  `scheduled_at`, which is the signature of the `*/5` tick. A deployment
  where no cron ran would have published nothing.
- **The service-role client demonstrably works.** That same scheduler path
  writes `publish_history` and `execution_logs` through
  `createSupabaseServiceRoleClient()`. If the key were unset, publishing
  would have stopped too.

So the leading hypotheses from the previous report are both weakened. What
remains is a narrower and more uncomfortable finding.

### The observability shipped in PR #175 has a hole

`persistSweepReport` returns early and writes **nothing** when the run
touched zero workspaces:

```ts
const workspaces = resolveReportWorkspaces(report);
if (workspaces.length === 0) {
  return { workspacesRecorded: 0, unattributed: true, errors: [] };
}
```

Workspaces are derived from candidate rows. A run that finds no candidates
therefore records nothing, and so does a run whose loaders threw — because
a failed loader yields no candidates either.

That is the exact failure this whole programme exists to remove, one level
up from where it was fixed:

| Situation | Durable record before this milestone |
|---|---|
| Sweep never ran | none |
| Sweep ran, found nothing | **none** |
| Sweep ran, both loaders failed | **none** |
| Sweep ran, measured something | one `activity_events` row per workspace |

Three distinct states, one indistinguishable absence. `report.diagnosis`
correctly explains all of them — but only in an HTTP response nobody is
reading, and in a log line on a platform this session cannot see.

**Fix:** a canonical `metrics_refresh_runs` row written once per run,
regardless of outcome, workspace-nullable. That is Phase 2's requirement
and it closes this hole directly.

---

## 3. What is genuinely unknown

`post_metrics` has been empty across at least four daily cron
opportunities (16–19 August) during which an in-window Bluesky candidate
existed and its fetch path needs no credentials at all. Every precondition
this session can verify is satisfied. The remaining possibilities are:

- the `/api/metrics/refresh` cron is not registered on the Vercel project
  even though it is present in `vercel.json`;
- the route runs and throws before the sweep begins;
- the sweep runs and every provider read fails.

**This session cannot distinguish them.** Signal's Vercel project is not in
the team reachable from here, so cron invocation history and runtime logs
are unavailable. The response to that is not more speculation — it is to
make the next run record itself, which is what this milestone builds.

One further honesty point: **the PR #175 observability has been live for
thirteen minutes and has had zero scheduled cron opportunities.** Nothing
about it has been proven in production. It is unit-verified only.

---

## 4. Validation reach of this milestone

Stated up front so no reader over-reads a green test run:

| Level | Available | Notes |
|---|---|---|
| Unit verified | ✅ | vitest, pure modules |
| Integration verified | ✅ | in-process, injected fakes |
| Local database verified | ❌ | Docker unavailable; the migration chain was **not** executed |
| Live provider read verified | ✅ (Bluesky), ⚠️ (X) | Bluesky public AppView is unauthenticated and was read; X needs a stored token this session must not use |
| Production verified | ❌ | no write, no migration application, no cron trigger |

---

## 5. Implications for the plan

1. **Phase 1 becomes verification, not application.** The migration is
   already live. The work is proving it matches intent and giving the
   operator read-only checks — plus a schema-drift test that would catch a
   mismatch between the file and the deployed database.
2. **Phase 2 gains a concrete defect to fix**, not a hypothetical: the
   zero-workspace write gap above.
3. **Phase 4/5 are unblocked and higher value than expected.** X numeric
   user ids are stored, so account snapshots and own-timeline
   reconciliation both work on X without new data.
4. **Nothing in this milestone may claim the pipeline works in
   production.** It has not been observed working. Every claim is labelled
   with its verification level.
