# Incident 2026-09-14 — "WebmasterID 1-3": two lost days from one expired token

Campaign `0b13dce0-7aae-4395-be98-8e1b4b589412`, operator
`@webmasterid.bsky.social`, 22,341 members, 400/day.

**Nothing in this document was executed against production.** Every
reproduction ran against the shipped migrations on a local PostgreSQL
with a provider double. No follow or unfollow was performed.

---

## 1. What production showed

| Observation | Value |
| --- | --- |
| Today: attempted / succeeded / already following / failed | 61 / 60 / 223 / 0 |
| Today's run | **failed** |
| The one unresolved action | `@mittelalterunibonn.bsky.social`, "Token has expired", reconciliation required |
| Yesterday's run | **failed**, 0 of 1 attempted |
| Campaign | **active**, next check tomorrow 09:00 |
| Accounts | **Signed in** |
| Relationships | 3 actions "needing reconciliation"; `@joinmef` "previous request may have reached Bluesky, no second Follow sent" |

## 2. Root cause — not the symptom

The first `createRecord` of every day carries an access token that
expired overnight. Bluesky answers `HTTP 400 {"error":"ExpiredToken"}`.
That is routine and is classified correctly as a refreshable auth
failure. Three defects turned it into two lost days.

### RC1 — an auth stop marked the RUN `failed`, and nothing resumes a failed run

`stop_campaign(reauthorization_required)` set the campaign to
`reauthorization_required` **and the run to `failed`**.
`resume_bluesky_campaign_run` moves only `rate_limited` runs; the
dispatcher returns on any run status but `running`; and
`activateCampaignAction` touches the campaign, never the run.

So: the operator reconnected on Accounts (→ "Signed in"), pressed
Resume (→ campaign `active`), and every tick for the rest of the day
said *"today's run is failed"* and did nothing. When the window closed,
the out-of-window branch moved `next_run_at` to tomorrow. **That is the
exact production state: active campaign, failed run, next check
tomorrow, 339 of 400 units unused, 22,058 members waiting.** Tomorrow
the token has expired again and the cycle repeats — which is why *both*
runs are `failed`.

### RC2 — the refreshed session did not survive the chunk

`attemptFollow` adopted the renewed session into `input.session` — the
chunk's own input object. The dispatcher handed every later chunk the
**original, expired** session, so every chunk of a pass began with a
refresh, each rotating Bluesky's single-use refresh token. Any
concurrent rotation (the publishing scheduler runs on the same `*/5`
cron) or one failed persist leaves the next chunk holding a dead refresh
token → `refresh_rejected` → `markExpired` → RC1. The existing test
("refreshes once for the whole chunk") ran one chunk and could not see
this.

### RC3 — a definitive rejection was filed as "may have reached Bluesky"

After provider intent, *every* non-success was recorded as
`reconciliation_required`. That is right when the response was lost
(network error, 5xx, unparseable 2xx). It is wrong for `400
ExpiredToken`: the PDS refused the request before writing anything.
Reconciliation reads relationship truth, which is `not_following`
forever, so the member cycled every ten minutes as *"may have reached
Bluesky — not re-sent"* and never received the retry it was owed. That
is `@joinmef` and the "3 actions needing reconciliation". The manual
path (`mutation-outcome.ts`) already separates `rejected` from
`ambiguous`; the worker did not.

### RC4 — a structural 4xx on one member stopped the whole campaign

Found by the conservation regression, not by the incident itself:
`structural_provider_failure` returned `stop_campaign(failed)`. One
member's `InvalidRequest` marked the whole campaign `failed` and
stranded every queued member behind it.

### RC5 — the run's stored budget was capped to the queue size

`effective_daily_quota` was `min(requested, identity remaining,
**remaining eligible**)` at run creation. A unit spent on a refused
request reduces the budget but not the queue, so a campaign whose queue
was smaller than its quota ended the day one member short. Invisible at
22,000; it would make a one-profile canary look broken.

### Why Accounts said "Signed in"

Because the operator had reconnected. `markExpired` correctly writes
`expired` to both `platform_connections` and `growth_accounts`, and the
Accounts page renders that as "Sign in again". The inconsistency was on
the campaign side: campaign and run said the session was dead after the
operator had already proven it alive.

## 3. What changed

| Area | Change |
| --- | --- |
| Worker | Returns the (possibly renewed) session; the dispatcher carries it across chunks. **One refresh per pass.** |
| Worker | `rejectedBeforeWrite` — auth, 429 and structural 4xx re-open the action (`pending`, marker cleared) for a real retry; network/5xx/unparseable-2xx stay in reconciliation. |
| Worker | Reconciliation heals an action whose *recorded* provider error is a definite rejection — production's three stranded rows resolve on the next pass. |
| Worker | Slow lane: reconciliation backoff 10 min ×12, then 6 h. Never terminal, never tight. |
| Worker | Retry backoff computed by PostgreSQL (`defer_bluesky_campaign_member`), not the app clock. |
| Worker | Closed reason codes on every terminal skip (`actor_not_found`, `ineligible`, …). |
| Outcomes | Structural 4xx is terminal for the member and counts toward the breaker; it no longer stops the campaign. |
| Dispatcher | Auth stop → run **`paused`** with `last_error_code = reauthorization_required`. `failed` is reserved for structural stops. |
| Dispatcher | Session resolved before the run is judged; a paused/failed run with a recoverable code resumes via `resume_bluesky_campaign_run_after_recovery` — same run, same counters. |
| Dispatcher | `reauthorization_required` campaigns whose account is `connected` again are probed (one `getSession` read) and recovered automatically. |
| Dispatcher | Completion gated by `bluesky_campaign_may_complete`. Per-pass visit guard. |
| Dispatcher | Run budget no longer bounded by queue size (`boundByQueue: false`). |
| Activate action | Also resumes today's run. |
| Migration | `20260915000001_campaign_run_recovery.sql` — see §5. |
| Both kinds | Every change mirrored into the Unfollow worker and dispatcher. |

### State machine

Run: `running → paused(reauthorization_required | dispatch_error) → running`
by recovery; `running → rate_limited → running` by reset; `running →
completed` by quota or queue; `running → failed` only for a structural
stop with no recoverable code. Never `failed` for authentication.

Member: unchanged set. `retryable` now covers two lanes distinguished by
the action: `pending` + no marker = owed a real attempt; `reconciliation_required`
= read-only until truth answers.

Action: `pending → running → succeeded | failed | skipped | reconciliation_required`,
plus `running | reconciliation_required → pending` by re-open, **only**
for a definite rejection code (closed set, enforced by the RPC).

## 4. Evidence

Real PostgreSQL (shipped migrations) throughout; real session resolver,
real refresh path, real connection persistence; only the network is a
double, and it counts every request.

| Scenario | Provider calls | Refresh | Attempts | Intents | Units | Actions | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Today's sequence (223 + 77) | 78 createRecord | **1** | 77 | 77 | 77 | 77 | run not failed; campaign completed; tokens rotated once and persisted |
| Refresh fails | 1 | 1 | 1 | 1 | 1 | 1 (pending) | run `paused`/reauth; campaign reauth; Accounts `expired`; 29 untouched |
| …then operator reconnects | +30 | 0 | +30 | +30 | +30 | still 1 for rf1 | **same run resumed**, all 30 done, rf1 written once |
| Ambiguous 502 at head | 1 for it | 0 | 1 | 1 | 1 | 1 | 149 later members done same pass; settles `succeeded` on read; 0 re-sends |
| Stranded ExpiredToken row | 1 | 0 | +1 | 2 | 2 | **1** | re-opened, retried once, counted once |
| 429 | 5 then 26 | — | — | — | — | — | same run resumed at reset; refused member written once |
| Crash before intent | 1 | — | 1 | 1 | 1 | 1 | one first createRecord |
| Crash after intent | 0 | — | 0 | 1 | 1 | 1 | reconciliation, marker cleared |
| Structural 4xx on one member | — | — | — | — | — | — | member terminal with reason; **campaign continues** |
| 100,000 members, 1,000/day, all faults | see `incident-scale.pg.test.ts` | ≤1/day | — | — | — | — | every member in one category; no member written twice; completed only at zero actionable |

Two-session (embedded PostgreSQL, one backend per connection): the
re-opened action is not taken over; re-open refuses ambiguous codes,
terminal actions and mismatched members; run-resume moves exactly once
under contention; a zero-unit reservation cannot fund a delete.

### Mutation checks — every fix reverted, one at a time, on the final code

A regression that cannot fail is not evidence. Each root-cause fix was
reverted in isolation (source or migration text patched back to the
deployed behaviour, the target suite run, the file restored) and the
suite had to fail **for that reason**. A revert whose pattern no longer
matched would be reported as SKIPPED, not as a pass. Run against the
code in this PR: **10 of 10 caught.**

| Reverted fix | Where | Test that caught it |
| --- | --- | --- |
| RC2 — renewed session not carried across chunks | dispatcher `session = chunk.session` | A–G sequence: refresh count ≠ 1; quota-smaller day |
| RC1 — auth stop marks the run `failed` again | dispatcher stop → run status | refresh fails: run is not `paused` |
| RC1 — in-dispatcher run recovery removed | dispatcher `isRecoverableRunStop` gate | run resumes when the operator pressed Resume |
| RC3 — definite rejections filed as reconciliation (no re-open) | worker settle block | refresh fails (action not `pending`); reconnect resumes same run |
| RC3 — reconciliation no longer heals a recorded definite rejection | worker `reconcileOnly` | stranded ExpiredToken row is re-opened |
| RC3 — takeover predicate reverted to the deployed one | migration `reserve_bluesky_campaign_quota` | two-session: a re-opened action is NOT taken over |
| RC4 — structural 4xx stops the whole campaign | `outcomes.ts` | conservation: every member in one category, campaign continues |
| RC5 — run budget bounded by queue size | dispatcher `boundByQueue: false` | 30-of-30 after reconnect (was 29 of 30) |
| Completion guard removed | dispatcher `bluesky_campaign_may_complete` gate | completion refused while an action is unresolved |
| Superseded-intent fold removed | migration `fold_bluesky_ledger_outcomes` | a refused-then-retried follow is counted ONCE |

The first pass caught 7 of 10. The three that survived — in-dispatcher
resume, the completion guard, the superseded fold — each named a
scenario no test exercised; those tests were added, and the controls
re-run until every revert failed.

## 5. Migration

`20260915000001_campaign_run_recovery.sql` — forward-only, additive.

- `reserve_bluesky_campaign_quota` and `fold_bluesky_ledger_outcomes`
  reproduced from the **installed** definitions (`pg_get_functiondef`,
  including the pg-safeupdate guards of `20260912000003`); behavioural
  diff is exactly the takeover predicate and the `superseded` fold case.
- New: `reopen_bluesky_campaign_action`,
  `resume_bluesky_campaign_run_after_recovery`,
  `bluesky_campaign_conservation`, `bluesky_campaign_may_complete`,
  `bluesky_follow_campaign_members.reconcile_count`.
- Grants: `service_role` only; PUBLIC/anon/authenticated revoked and
  asserted with `has_function_privilege`.

**Order: migration before code.** The deployed worker never calls the
new RPCs, and the changed ones are call-compatible; the new code would
fail loudly without the migration (`function does not exist`) rather
than silently.

Pre-flight:
```sql
select proname from pg_proc where proname in ('reopen_bluesky_campaign_action','resume_bluesky_campaign_run_after_recovery','bluesky_campaign_conservation','bluesky_campaign_may_complete');  -- expect 0 rows
```
Post-apply:
```sql
select pg_get_functiondef(to_regprocedure('public.reserve_bluesky_campaign_quota(uuid,uuid,uuid,uuid,date,integer,integer,integer,integer,text)')) ~ 'reconciliation_required' as predicate_ok,
       pg_get_functiondef(to_regprocedure('public.reserve_bluesky_campaign_quota(uuid,uuid,uuid,uuid,date,integer,integer,integer,integer,text)')) ~ 'where true' as safeupdate_ok;
select has_function_privilege('service_role','public.reopen_bluesky_campaign_action(uuid,uuid,uuid,text,text)','EXECUTE'),
       has_function_privilege('authenticated','public.reopen_bluesky_campaign_action(uuid,uuid,uuid,text,text)','EXECUTE');  -- true, false
```

Healing production's three stranded rows needs no data migration: the
next pass reads their recorded `ExpiredToken`, re-opens them, and
retries them through the ordinary quota path.

## 6. Supervised production verification — DESIGNED, NOT EXECUTED

1. Apply the migration; run the post-apply checks.
2. Deploy.
3. Confirm the three stranded actions leave `reconciliation_required`
   on the next pass, each with exactly one further `createRecord`:
   ```sql
   select a.subject_did, a.status, count(l.*) filter (where l.provider_intent_at is not null) as intents
     from public.bluesky_relationship_actions a
     left join public.bluesky_campaign_attempt_ledger l on l.action_id = a.id
    where a.campaign_id = '0b13dce0-7aae-4395-be98-8e1b4b589412' and a.subject_did in (…)
    group by 1,2;   -- intents 2, status succeeded
   ```
4. Next morning: the first write carries an expired token. Expect **one**
   `refreshSession` in provider logs for the whole pass, the run
   `running` → `completed`, `attempted_count` approaching 400, and
   `next_run_at` = the following day.
5. Controlled transient failure: none can be induced safely in
   production; rely on the regression suite.
6. Reauthorization: sign the account out on Accounts during a run.
   Expect: run `paused`/`reauthorization_required`, campaign
   `reauthorization_required`, Accounts "Sign in again", zero further
   provider calls. Sign in again. Expect the next tick to recover the
   campaign and resume the **same** run with unchanged counters.
7. Duplicate check (runbook §10) after each of the above: zero rows.

Not "production ready" until 3, 4, 6 and 7 have been observed.
