# Bluesky Relationships — production hardening

Six changes on top of the shipped subsystem. Nothing in the original
design was loosened: DID-keyed identity, workspace authorization,
immutable confirmed batch membership, protected-account exclusion,
cursor-based import completeness, rate-limit stopping, and the rule that
an unknown outcome is never retried automatically all hold, and the
tests that enforce them are unchanged except where they got **stricter**
(NC8, below).

**No real Follow or Unfollow was performed. No production data was
mutated, no live profile was imported, no migration was applied, and
nothing was deployed or merged.** Every provider mutation in this work
was exercised against mocks and a constraint-enforcing fake.

---

## 1. Canonical handle presentation

Production rendered `@@webmasterid.bsky.social`.

The value was not corrupt. `growth_accounts.handle` legitimately stores
whatever the operator typed when they created the identity — including a
leading `@` — and the UI wrote `@{handle}` at every call site.

`normalizeBlueskyHandle` could not be reused: it strips exactly one
leading `@`, so `@@name` becomes `@name`, and it lowercases, which is
right for an API call and wrong for a label. Both facts are pinned by
tests so the shortcut is not retried.

`handle-display.ts` is pure and client-safe. `formatHandle` is
idempotent, because these values pass through props, notices and
activity titles where a second formatting pass is easy to add and
invisible. Applied to the identity selector, targets, candidates, source
chips, notices and history snapshots. **Nothing stored is modified** —
the fix is at the render boundary precisely so handles stay as written,
and DIDs remain the only identity.

A guard fails if `@{` or a `@${` template returns to either surface.

## 2. Explicit human confirmation

Follow, Unfollow and Remove target no longer execute on the first click.

The cancel guarantee is **structural**. The only `<form action={dispatch}>`
for these actions exists inside the dialog; the triggers are plain
`type="button"` controls. Cancel unmounts the only form that could
dispatch — which holds for the button, Escape, the backdrop and unmount
alike, rather than for whichever paths a test happened to exercise.

The dialog is a native `<dialog>` opened with `showModal()`, so the focus
trap, Escape handling and background inertness come from the platform
rather than from a hand-rolled trap that misses Shift+Tab. It is
labelled and described, and states the actor identity, the action, the
count, a review list, the protected exclusions and the external effect.

Single-account actions take the identical path. One row is still a
public, irreversible change to someone else's feed.

**Confirmation is not authorization.** A test asserts the actions read no
`confirmed` flag from the payload.

## 3. Bounded mutations

`MAX_RELATIONSHIP_BATCH_SIZE = 20`, chosen by arithmetic:

| | per action | 20 actions |
| --- | --- | --- |
| success path | ~0.8s call + 1.0s spacing | ~35s |
| every action ambiguous | ~1.6s calls + 1.0s spacing | ~51s |

against `maxDuration = 60` now declared on the page segment. 25 would be
64s worst case. A test asserts the cap and the budget stay in step, so
raising one without the other fails.

**Spacing was not reduced to buy headroom.** `INTER_REQUEST_MS` and both
rate-limit floors are asserted unchanged.

The UI cap is a convenience; the server check is the control. A FormData
is trivially forged, so the action rejects on the **resolved id count**
— before a session, a row or a provider call — and a test asserts it
reads the list length rather than any client-supplied count field.

"Select all" is now **"Select visible (N)"**. The old label implied the
whole table while the list was one page of it.

If a batch still times out nothing is lost: each action persists before
the next begins. The cap makes a timeout unlikely; it was already
survivable.

## 4. Paused batch recovery

The loader already read `bluesky_action_batches`; nothing rendered them,
so a batch that stopped halfway was invisible.

A Batches tab shows progress, and a paused batch with work left gets
Continue. On **every** continuation the action re-establishes: the
caller's session, workspace membership, `connect_platforms`, that the
identity is theirs, that the batch belongs to that identity, and the
Bluesky session. A confirmation from an hour ago authorizes nothing now.

It continues the frozen membership **read back from the database**, and
within it only `pending` rows. `createAction` and `confirmBatch` are
both absent from the function, so it structurally cannot widen
membership. `reconciliation_required` rows are never re-sent; `failed`
rows are not retried.

Candidate state is re-read, so protection applied *after* confirmation is
honoured — covered by a test.

An auth-paused batch stays non-resumable: `resolveRelationshipSession`
will not resolve until the operator reconnects.

## 5. Scalable reads

The loader read 500 rows and derived every total from that array. Past
500 it under-reported silently and rows 501+ were unreachable.

Totals now come from `count: "exact", head: true` queries that transfer
no rows. `applyCandidateFilters` is shared by the page query and every
count query, so a filter cannot be applied to one and forgotten on the
other. History is paginated the same way; the reconciliation count is
its own exact query, since it is a standing condition the operator must
not page past.

**Ordering carries a second key.** Imports write a page of rows inside one
millisecond, so ordering on `last_discovered_at` alone leaves ties
undefined between requests — a row appears on two pages and on none. The
tests seed 1,200 rows with identical timestamps and walk every page
asserting each id is seen exactly once.

The surface is now a function of the URL, so filtered views are
shareable and Back works. Any change to tab, search or filter resets
paging. Search is debounced at 350ms and covers handle and display name;
the DID is deliberately excluded, since a partial DID match is
meaningless to a human.

## 6. Error and mobile UX

Three failures looked identical and must not be: a timeout, an unapplied
migration, and a refused read. `classifyReadFailure` names them.

**The default for an unrecognised error is structural, not temporary.**
A "try again" panel over an unapplied migration is worse than a crash —
it looks survivable and hides the one fact that would fix it.

The failure renders **instead of** the lists, never beside an empty one:
"No candidates yet" next to a failed read looks like success.

Writing the test for the wrapped error shape found a real bug:
`RepositoryError` carries its own `code`, which shadowed the Postgres
code in `cause`, so a genuine `42P01` classified as unrecognised.

---

## Risk review

| Risk | Likelihood | Mitigation | Residual |
| --- | --- | --- | --- |
| Confirmation trains operators to click through | Medium | Copy is specific per action and honest about mild ones (Remove target says no relationship changes) | Fatigue over time; not measurable here |
| Batch cap too small for real use | Medium | Batches are recorded separately and lose nothing between them; Continue resumes | Operator does more clicks for large campaigns — deliberate |
| `maxDuration = 60` still exceeded | Low | Per-action persistence + Continue | A timed-out request returns no summary; the Batches tab is the recovery path |
| Exact-count queries cost 7 round trips per page | Medium | All `head: true`, no rows transferred, parallel | Noticeable only on a cold connection |
| Search debounce still allows bursts | Low | 350ms; server-side, indexed columns | A fast typist can issue ~3 queries per word |
| Continue re-runs against stale candidate state | Low | Candidate state re-read per continuation | A relationship changed *during* the continuation is handled by the executor's preflight |
| Native `<dialog>` unsupported | Low | Baseline since Safari 15.4 / Chrome 37 | Very old browsers get an unstyled non-modal dialog, still functional |
| Handle formatter hides a genuinely malformed handle | Low | `handle.invalid` is preserved and rendered | A handle that is only `@` renders as "handle unavailable" rather than raising |
| **Migration still unapplied** | **Certain** | Classifier names it explicitly instead of hiding it | **The feature cannot work until it is applied — unchanged by this milestone** |

## Manual QA checklist

Requires an applied migration and a signed-in Bluesky identity. Steps
marked **(mutating)** perform real, public, irreversible actions —
they are the ones this milestone did not and could not perform.

### Presentation
- [ ] An identity whose stored handle begins with `@` renders as
      `@handle`, not `@@handle`, in the selector, targets, candidates,
      source chips and history.
- [ ] A candidate whose provider handle is `handle.invalid` still shows
      it rather than being hidden.
- [ ] A screen reader announces checkboxes as "Select handle", not
      "Select at handle".

### Confirmation
- [ ] Follow selected, Unfollow selected, per-row Follow, per-row
      Unfollow and Remove all open a dialog rather than acting.
- [ ] Cancel, Escape and a backdrop click all dismiss with **no network
      request** (check DevTools Network — this is the guarantee).
- [ ] Tab is trapped inside the dialog; focus returns on dismissal.
- [ ] Selecting a protected account and opening Unfollow shows the
      exclusion count, and the confirmed payload omits it.

### Limits
- [ ] Selection stops at 20; unchecked rows go inert, checked stay
      interactive.
- [ ] "Select visible (N)" matches the rows on screen, not the total.
- [ ] A forged FormData with 21+ `candidate_id` fields is rejected with
      the batch-size message.

### Batches
- [ ] A batch paused by a rate limit appears with correct counts.
- [ ] **(mutating)** Continue processes only the remaining rows.
- [ ] Continue is unavailable while the identity is disconnected, with
      an explanation.
- [ ] Reconciliation-required rows are not re-sent by Continue.

### Reads
- [ ] With >500 candidates the tab badge shows the true total.
- [ ] Paging to the last page reaches rows past 500.
- [ ] Search narrows both the list and the counts; clearing restores.
- [ ] Changing tab or filter resets to page 1.
- [ ] History pages independently of candidates.

### Errors
- [ ] With the migration unapplied, the page says the tables are missing
      and offers **no** Retry.
- [ ] A transient failure offers Retry, which lands on the same URL.
- [ ] Neither case renders an empty list.

### Layout
- [ ] 320 / 360 / 390 / 430 / 768 / 1280 px: no page-level horizontal
      scrolling on Targets, Candidates, Following, Mutual, Batches,
      History, the confirmation dialog, or either error state.
