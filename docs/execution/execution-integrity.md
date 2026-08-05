# Execution integrity

The invariants that keep Signal from publishing something twice, from
claiming a capability it does not have, and from spending on AI without
a budget.

Written after the P0 Execution Integrity milestone. Every statement here
is enforced by a test; where something is *not* enforced, this document
says so.

## The defect shape this milestone targets

Signal's recurring failure is not exotic. It is:

> a guard is corrected on one path and left divergent on its siblings.

Every hotfix in the P0 series is an instance. PR4 stopped the scheduler
auto-retrying publishes whose outcome was unknown — and did not reach
the operator's "Try again", the weekly-plan "Schedule retry", or the MCP
scheduling tool. P0.1 fixed an authorization gate on the MCP path; P0.1b
then had to reconcile the two sibling readers.

The countermeasure is structural, not vigilance: **one shared decision
function per invariant, plus a static test that asserts every caller
uses it.** A second copy of a rule is the drift.

## Retry firewall (P0.2)

### Outcome classes

Every publish attempt lands in one of five classes. The class — not the
`execution_items.status` — decides who may cause it to run again.

| Class | Meaning | May retry |
|---|---|---|
| A safe | provider definitely not attempted; validation or deterministic pre-network refusal | yes |
| B conditional | provider attempted and definitively confirmed no publication, or a transient failure with reliable provider semantics | yes, with backoff |
| C unknown | dispatched, result never confirmed: timeout, connection lost after dispatch, malformed response after possible success, status 0 | **never automatically, never by a generic "Try again"** |
| D partial | some parts of a multi-part publish are live | **never blindly; explicit operator recovery only** |
| E published | provider id, permalink, or explicit success | **never** |

`status = 'failed'` is *not* a class. It collapses "the provider refused
before writing anything" and "the provider may have published and we
never heard back" into one value. That collapse is what made every
retry path unsafe.

### Where the decision lives

`src/core/publishing/retry-eligibility.ts` — pure, no I/O, no platform
knowledge. It reads only state that is already persisted at
`execution_items.metadata.publish_outcome`:
`{status, reason_code, reason_detail, external_id, external_url}`,
written by `applyOutcome` and surviving a requeue. **No migration was
required.**

Provider evidence outranks the status field: a row marked `failed` that
carries a permalink is class E, because the post exists.

The predicate deliberately does **not** re-decide A vs B. That lives in
`publish-retry-policy.ts`, which the scheduler consults for backoff and
attempt budget. Duplicating a 76-member reason-code taxonomy in a second
place would recreate the drift this milestone removes. The predicate
owns one question: *which classes may be retried at all, and by whom.*

### Callers

| Path | File |
|---|---|
| scheduler automatic retry | `publishing-scheduler.ts` → `publish-retry-policy.ts` |
| operator "Try again" | `app/(app)/execution/items/[id]/_actions.ts` |
| weekly-plan "Schedule retry" | `app/(app)/weekly-plan/_actions.ts` |
| MCP `signal.schedule_publish` | `mcp/tools/schedule-tools.ts` |

**Rescheduling is not a way around the firewall.** "Schedule retry" does
not retry the old row — it mints a fresh `execution_item`, so the
scheduler's own protection never applies to it. It consults the
predicate against the previous attempt before inserting.

Enforced by `src/test/retry-firewall-coverage.test.ts`, which also
asserts no caller re-implements the classification locally.

### Partial success

Initial recovery behaviour, deliberately minimal:

- published-part evidence is preserved (`thread_position_failed`,
  `thread_total`, `root_uri` on the outcome metadata)
- generic retry is refused
- explicit operator recovery is required

**Resume-from-part is not implemented** and should not be until
provider-specific idempotency is proven. Re-running a thread from part 1
duplicates every part already live.

### Unknown-outcome classification at the publishers

A non-idempotent CREATE whose response never arrived must emit
`publish_outcome_unknown`. All six real publishers now do:

| Publisher | Covered by |
|---|---|
| X, dev.to, Hashnode | PR4 |
| Bluesky, Reddit, Telegram | P0.2 |

Before P0.2 the latter three emitted `platform_api_error`, which the
retry policy treats as transient when `http_status` is 0 — so the
scheduler re-ran them automatically.

### Outcomes must be persisted

`publishOne` owns its own persistence. Three pre-provider gates used to
return an outcome without writing it, leaving the row at `running`
forever — invisible to the tick, and eventually surfacing as a stale
claim telling the operator a post "may already be live" when the
provider had never been called. All returns now go through `persist()`.

## Capability truth (P0.3)

```
MCP schedulable  ⊆  scheduler autonomous  ⊆  real publisher implemented
```

Each layer may be **narrower** than the one beneath it, never wider. A
wider claim advertises something that cannot succeed.

`PLATFORMS_WITH_REAL_PUBLISHER` is declared beside the runner's dispatch
switch and pinned against the filesystem: publishers are identified by
their exported `publishTo<Platform>` function, and a stub by the
`publishNotImplemented` marker. Declaring a stub as real, or
implementing a publisher without declaring it, fails the build.

Current state:

| Layer | Members |
|---|---|
| real publisher | bluesky, devto, hashnode, reddit, telegram, x |
| scheduler autonomous | the same six |
| MCP schedulable | bluesky, devto, hashnode, telegram, reddit |

The deliberate gap is `{x}`: X has a real publisher and is
scheduler-autonomous, but the MCP surface does not expose it. Widening
that would be *enabling a platform*, not fixing a bug — so the test
asserts the gap is exactly `{x}`, making any future change a conscious
decision rather than drift.

LinkedIn is absent from every layer: its publisher is a stub, and its
OAuth callback is unimplemented so no token can be stored. It takes the
same `platform_not_supported` path as YouTube, Threads and Instagram.

Enforced by `src/test/platform-capability-truth.test.ts`.

## AI usage enforcement (P0.5)

Metering lives at `callGenerationProvider` — the lowest shared function
that actually dispatches a request. The metering context is a
**required** parameter, so the type system refuses a provider call that
is not attributable to a budget: a future caller is metered by
construction rather than by remembering.

- The budget is checked **before** provider selection and before any
  request goes out, so a refusal never costs a token.
- `usage_limit_exceeded` is a distinct outcome, not folded into
  `provider_unavailable`. Nothing was dispatched, and the remedy differs.
- The ledger counts `draft.generated` / `draft.rewritten` activity
  events. Both UI and MCP already wrote them, so this was an enforcement
  gap, never an accounting one.
- **Fail-open is preserved**: when the ledger itself cannot be read, the
  call proceeds. That is the pre-existing documented rule — a database
  blip must not stop a founder from writing.

Enforced by `src/core/generation/providers/usage-enforcement.test.ts`.

## Known gaps

Recorded honestly rather than implied away.

**Provider 5xx after a non-idempotent CREATE is still auto-retried** on
X, dev.to and Hashnode (`*_provider_unavailable` sits in
`ALWAYS_TRANSIENT`). By the class definitions this is C — a gateway 5xx
does not tell us whether the backend processed the create. Reclassifying
it would stop every transient provider outage from self-healing and
route it to manual operator recovery instead, which is a material
product tradeoff rather than a bug fix. It needs an explicit decision.

**Post-2xx malformed-response branches are class C by accident** on
X, dev.to, Hashnode and Bluesky: they are non-transient only because
they carry no `http_status`. Adding one would silently flip them to
auto-retry.

**`ready_for_manual_publish` is invisible to the MCP duplicate check**,
so an operator who has already posted by hand can have the item
rescheduled underneath them.

**No `provider_attempted` field exists.** The closest proxy is
`publish_history.metadata.provider_attempted`, derived from
`endpoint !== null` and never read by any code. The retry decision and
the audit row therefore derive provider-attempt from different fields.

**Scheduler fairness and the missing due-item index** are deliberately
out of scope — they need production-data preflight (P0.4).
