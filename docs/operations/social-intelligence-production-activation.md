# Social intelligence — production activation runbook

Status: current as of the `feat/social-intelligence-production-reliability` milestone.
Baseline: `origin/main` @ `837d467`.

Follow the steps in order. Each has a **check** you can run and a
**pass condition**. If a check fails, stop there — later steps assume the
earlier ones held.

**No secret value appears in this document, and none needs to.** Every
check below distinguishes "configured" from "not configured" without
reading the value.

Two conventions:

- `$SECRET` is the shared cron/operator bearer token — whichever of
  `CRON_SECRET` or `SCHEDULER_TICK_TOKEN` is set. Never paste it into a
  ticket, a log, or this file.
- Every request below is **read-only** unless the step says otherwise.
  Nothing here publishes, edits or deletes provider content.

---

## Step A — migration

Two migrations are relevant. As of 2026-08-19 the **first is already
applied** in production; the second ships with this milestone.

| Migration | What it adds | State |
|---|---|---|
| `20260819000001_social_performance_intelligence` | `post_metrics` provenance columns, `account_snapshots`, widened `publish_history.mode` | **applied** (verified 2026-08-19) |
| `20260819000002_metrics_refresh_runs` | `metrics_refresh_runs` | **not applied** |

### A1. Verify current state before changing anything

```sql
-- Expect 6
select count(*) from information_schema.columns
where table_schema='public' and table_name='post_metrics'
  and column_name in ('provider_published_at','age_hours','age_window',
                      'freshness','confidence','provider_payload_version');

-- Expect 1 for account_snapshots, 0 for metrics_refresh_runs (before A2)
select table_name from information_schema.tables
where table_schema='public'
  and table_name in ('account_snapshots','metrics_refresh_runs');

-- Expect: api, manual, external, unknown
select pg_get_constraintdef(oid) from pg_constraint
where conrelid='public.publish_history'::regclass
  and conname='publish_history_mode_check';
```

### A2. Apply the outstanding migration

`supabase/migrations/20260819000002_metrics_refresh_runs.sql`

It is additive: it creates one table, two indexes and one SELECT policy.
It alters no existing table and rewrites no row. The invariant test
`src/test/measurement-reliability-invariants.test.ts` asserts all of
that from the SQL itself.

### A3. Verify after applying

```sql
-- Expect 1
select count(*) from information_schema.tables
where table_schema='public' and table_name='metrics_refresh_runs';

-- Expect true
select relrowsecurity from pg_class
where oid='public.metrics_refresh_runs'::regclass;

-- Expect exactly one SELECT policy, no INSERT/UPDATE policy
select policyname, cmd from pg_policies where tablename='metrics_refresh_runs';

-- Expect both indexes
select indexname from pg_indexes where tablename='metrics_refresh_runs';

-- Historical rows untouched: expect 92
select count(*) from public.publish_history;
```

**Pass condition:** table exists, RLS on, one SELECT policy, both
indexes, `publish_history` still 92 rows.

---

## Step B — environment

Confirm **presence**, never values.

| Variable | Needed for | How to tell it is set |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | every sweep write | Step C returns 401 not 503 |
| `CRON_SECRET` or `SCHEDULER_TICK_TOKEN` | cron auth | an unauthenticated GET returns 401 not 503 |
| `TOKEN_ENCRYPTION_KEY` | X token decryption | Step D reports a decryption failure if absent |
| `X_READ_PRICE_USD_PER_RESOURCE` | optional | Step H reports `price.source` |
| `SIGNAL_DAILY_X_READ_BUDGET` | optional, default 500 | Step H reports the limit |

```bash
# Unauthenticated. 401 = secret configured. 503 = NOT configured.
curl -s -o /dev/null -w "%{http_code}\n" https://signal.webmasterid.com/api/metrics/refresh
```

**Pass condition:** `401`.

> A `503` means neither cron secret is set, and it is the one state the
> system cannot record for you — without a database connection there is
> nowhere to write a run record. That is why this check is an HTTP status
> rather than a query.

---

## Step C — cron

### C1. Confirm the schedule is deployed

`vercel.json` declares `/api/metrics/refresh` at `0 6 * * *`. Confirm the
Vercel project lists it under **Settings → Cron Jobs** and shows an
invocation history.

> This is the one check nothing in the codebase can perform. As of the
> Phase 0 audit, every other precondition was satisfied and
> `post_metrics` was still empty across four daily opportunities, so the
> cron registration is the leading remaining hypothesis.

### C2. Trigger one run by hand

```bash
curl -s -X GET https://signal.webmasterid.com/api/metrics/refresh \
  -H "Authorization: Bearer $SECRET" | jq '{ok, report: .report | {phase, candidates, attempted, succeeded, zeroReason, diagnosis}, runRecorded}'
```

**Pass condition:** HTTP 200, `runRecorded.recorded == true`, and
`report.diagnosis` is a sentence that explains the outcome.

Record the `report.runId`. Every later check can be joined to it.

### C3. Confirm the run was recorded

```sql
select run_id, trigger, phase, publication_candidates,
       provider_reads_attempted, provider_reads_succeeded,
       zero_reason, diagnosis
from public.metrics_refresh_runs
order by started_at desc limit 5;
```

**Pass condition:** a row exists. `trigger` reads `manual` for a
hand-run and `cron` for a scheduled one.

**If `provider_reads_succeeded` is 0**, `zero_reason` says why. The
expected value on first run is `all_outside_window` — 44 measurable
publications exist and only the two from 15 August fall inside the
14-day enrolment window. That is not a fault; it is Step H's job.

---

## Step D — controlled X smoke test

Read-only. One post. Nothing is written.

```bash
curl -s -X POST https://signal.webmasterid.com/api/metrics/smoke \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
  -d '{"platform":"x"}' | jq '.results[] | {platform, ok, providerReadOk, persistenceOk, checks}'
```

**Pass condition:** `ok: true`, and the `impressions are readable` check
reports a number.

Failure readings:

| Check detail contains | Meaning | Action |
|---|---|---|
| `401` | token invalid or revoked | reconnect the identity |
| `client-not-enrolled` / `402` | billing | enable pay-per-use at `console.x.com` |
| `UsageCapExceeded` | monthly cap | wait for the cycle or change plan |
| `decryption is unavailable` | `TOKEN_ENCRYPTION_KEY` unset | set it |

**Cost:** this reads one post. At the documented Owned Reads rate that is
$0.001.

---

## Step E — controlled Bluesky smoke test

```bash
curl -s -X POST https://signal.webmasterid.com/api/metrics/smoke \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
  -d '{"platform":"bluesky"}' | jq '.results[] | {platform, ok, checks}'
```

**Pass condition:** `ok: true`, including
`impressions are unavailable, not zero`.

This path is unauthenticated and free.

> Already verified from a developer machine on 2026-08-19 against
> `at://did:plc:nrru4wabbdh4zhnzwhhnvq5r/app.bsky.feed.post/3mt4uuimqhp2e`:
> 7/7 checks passed, `likes=1 reposts=0 replies=0 quotes=0 bookmarks=0`,
> no impression-like field present. Re-running it from production
> confirms the deployed code path, not the provider.

---

## Step F — persistence

After Step C2, confirm measurements actually landed.

```sql
select platform, status, freshness, age_window,
       jsonb_object_keys(metrics) as counter, fetched_at
from public.post_metrics
where source not like 'snapshot:%'
order by fetched_at desc limit 20;

-- Immutable history points
select count(*) from public.post_metrics where source like 'snapshot:%';
```

**Pass condition:** at least one row with `status='connected'` and a
non-null `freshness`. Counters must be real numbers; a Bluesky row must
have **no** `impressions` key.

---

## Step G — account snapshots

Account context is collected inside the same sweep, once per account per
day.

```sql
select platform, handle, followers, following, post_count,
       freshness, error, fetched_at
from public.account_snapshots
where source not like 'snapshot:%'
order by fetched_at desc;
```

**Pass condition:** one row per connected identity. `followers` may be
`NULL` if the provider did not report it — that is correct and is not
zero. A row with `freshness='provider_error'` and null counts records a
failed read rather than hiding it.

---

## Step H — bounded historical backfill

**Preview first. Always.**

### H1. Preview (contacts no provider, writes nothing)

```bash
curl -s -X POST https://signal.webmasterid.com/api/metrics/backfill \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
  -d '{"since":"2026-05-01T00:00:00Z"}' | jq '.plan | {selected, batches, costSummary, budget, gate}'
```

Read `plan.selected`, `plan.cost.resources.xResources`,
`plan.cost.estimatedUsd` and `plan.cost.costKnown`.

Expected for the current history: ~15 X and ~13 Bluesky publications,
estimated **$0.015** at the documented rate.

> **If `costKnown` is false**, the price could not be established — the
> documented rate has aged past its freshness horizon, or the configured
> one is malformed. The run will refuse. Either set
> `X_READ_PRICE_USD_PER_RESOURCE`, or authorise by resource count with
> `confirmedMaxResources`. An unknown price is not a free one.

### H2. Free platforms first

```bash
curl -s -X POST https://signal.webmasterid.com/api/metrics/backfill \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
  -d '{"since":"2026-05-01T00:00:00Z","platforms":["bluesky"],"execute":true}' \
  | jq '.result | {measured, attempted, failed, rateLimited, summary}'
```

Bluesky costs nothing, so this needs no spend confirmation and proves the
whole path before any money is involved.

### H3. Paid run, explicitly authorised

```bash
curl -s -X POST https://signal.webmasterid.com/api/metrics/backfill \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
  -d '{"since":"2026-05-01T00:00:00Z","platforms":["x"],"execute":true,"confirmedMaxUsd":0.05}' \
  | jq '.result | {measured, attempted, failed, summary}'
```

**Pass condition:** `measured` matches the previewed count. A partial
result is safe to re-run — persistence is idempotent, and rate-limited
posts are simply picked up next time.

---

## Step I — UI

Open **/measurement-health** and confirm it agrees with the database.

- Measurement system: last run and last successful run are separate facts
- Providers: one row each, with X and Bluesky judged independently
- Post coverage: shows `covered / measurable`, and states that blocked
  and failed attempts are excluded
- Account context: follower counts, or `Never measured` — never `0`
- Historical backfill: remaining work and today's X budget

Then open **/account-health** for audience and content signals.

**Pass condition:** nothing reads `No data`, `N/A` or `--`, and no cell
shows `0` for something that was never measured.

---

## Step J — 24-hour verification

The following day:

```sql
select run_id, trigger, phase, started_at,
       provider_reads_succeeded, snapshots_written,
       account_snapshots_written, zero_reason, diagnosis
from public.metrics_refresh_runs
where trigger = 'cron'
order by started_at desc limit 3;
```

**Pass condition:** a row with `trigger='cron'` from roughly 06:00 UTC.

That row is the whole point of this milestone. Before it, a cron that
never fired and a cron that fired and found nothing were indistinguishable.

Then confirm via MCP or the UI:

```
signal.social.measurement_health
```

Expected once activation is complete: `overall: "healthy"`, both
providers healthy or explicitly `never_run`, and no critical alerts.

---

## Rollback

Every change in this milestone is additive.

- **Code:** revert the branch. The previous sweep behaviour returns.
- **Schema:** `metrics_refresh_runs` can be left in place harmlessly — it
  is a new, unreferenced-by-others table. To reverse it:
  `drop table if exists public.metrics_refresh_runs;`
- **Data:** no existing row was altered by this milestone, so there is
  nothing to restore.

Dropping the table degrades health reporting to `configuration_error`
with "the migration has probably not been applied", which is the correct
description of that state.

---

## What this runbook cannot do for you

- **Register the Vercel cron.** Not visible from the codebase.
- **Read your X billing state.** Only `console.x.com` has it.
- **Prove the cron fired before Step J.** The first cron-triggered run
  record is the proof, and it arrives on its own schedule.

Everything else above is checkable from a terminal with a secret you
already hold, and nothing in it requires pasting that secret anywhere it
is not already in use.
