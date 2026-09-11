# Negative controls — Bluesky relationship actions

Ten invariants. For each one the defect was **actually introduced into
the source**, the suite was run, the named tests were observed to fail,
and the code was restored. A control nobody has seen fail is a control
nobody has tested.

Run on branch `feat/bluesky-relationship-actions` against
`npx vitest run src/core/bluesky-relationships/` (174 tests when green).

---

## 1. Handle used instead of DID identity → fails

**Defect introduced:** changed the candidate table's uniqueness
constraint from
`unique (workspace_id, operator_account_id, subject_did)` to
`unique (workspace_id, operator_account_id, handle)`.

**Failed (2):**
- `NC1 — the candidate uniqueness constraint is on subject_did, not handle`
- `NC1 — no unique index anywhere in the migration is keyed on a handle`

**Why the invariant matters:** the provider returns the literal string
`handle.invalid` for accounts whose handle cannot be verified — it is the
first follower `bsky.app` returns. Two such accounts would collide into
one candidate row under a handle key, and a rename would orphan a row's
entire action history.

## 2. Duplicate active Follow → fails

**Defect introduced:** removed the `where status in ('pending',
'running')` clause from `bluesky_relationship_actions_one_active`,
turning the partial unique index into an ordinary one (which would then
forbid *all* repeat actions rather than concurrent ones).

**Failed (1):** `NC2 — a partial unique index covers pending/running actions`

Behavioural half, in `execute-actions.test.ts`: `a second in-flight
follow for the same DID is refused by the database` attempts the insert
against a fake that enforces the real index.

**Why:** `createRecord` is not idempotent. Two concurrent follows of one
account leave two live follow records, one of which Signal has no row
for and can therefore never clean up.

## 3. Provider lookup failure becoming `not_following` → fails

**Defect introduced:** changed `relationshipsUnavailable` to emit
`state: "not_following"` instead of `"unknown"`.

**Failed (3):**
- `relationshipsUnavailable — maps EVERY requested DID to unknown`
- `NC3 — relationshipsUnavailable cannot emit not_following for any failure kind`
- `executeFollowAction — an ambiguous follow whose RECONCILE ALSO fails stays unknown`

**Why:** a rate limit or an outage would otherwise be recorded as "we
checked, and you follow nobody" — which makes a later batch unfollow a
silent no-op and a later batch follow a source of duplicate records.

## 4. Unknown Follow outcome blindly retried → fails

Two defects were tried.

**4a — reconciliation concludes failure:** made `reconcileFollow` return
`status: "failed"` when the provider reports not-following.

**Failed (5)** including `NC4 — reconcileFollow can only conclude
succeeded or reconciliation_required` and `NC4 — a reconcile reading 'not
following' does NOT authorise an automatic re-send`.

**4b — an actual retry loop:** inserted a second `createFollowRecord`
call into `executeFollowAction`'s ambiguous branch, before the truth
read.

**Failed (3):**
- `executeFollowAction — an AMBIGUOUS follow reads truth and sends exactly ONE createRecord`
- `executeFollowAction — an ambiguous follow whose truth says NOT following stops at reconciliation_required`
- `executeFollowAction — an ambiguous follow whose RECONCILE ALSO fails stays unknown`

4b is the sharper control: it counts provider calls rather than
inspecting a return value, so it catches a retry however it is spelled.

## 5. Unknown Unfollow outcome blindly retried → fails

**Defect introduced:** inserted a second `deleteFollowRecord` call into
`executeUnfollowAction`'s ambiguous branch — the change a reasonable
person would make on the grounds that `deleteRecord` is idempotent.

**Failed (2):**
- `executeUnfollowAction — an AMBIGUOUS unfollow sends exactly ONE deleteRecord despite idempotence`
- `executeUnfollowAction — an ambiguous unfollow whose truth says gone is a success`

**Why idempotence is not a licence:** a repeat delete is harmless in
itself. The danger of unfollow is aiming at the *wrong* record, and an
automatic loop that re-derives its target is how that happens. Both
mutation paths therefore go through the same operator gate, so there is
one rule to reason about rather than two.

## 6. Protected account included in batch Unfollow → fails

**Defect introduced:** moved the `protectedRelationship` guard in
`preflightUnfollow` from first position to last, below the DID check,
the `not_following` check and the missing-rkey check.

**Failed (2):**
- `NC6 — protection refuses regardless of every other signal`
- `NC6 — protection is checked FIRST, so its reason is the one reported`

The first fails on the `not_following` and missing-rkey combinations,
which now return before protection is consulted. The second fails
because a protected candidate with no rkey reports the rkey failure —
telling the operator the wrong reason for the skip.

Protection is additionally enforced twice more: the server action filters
protected candidates out **before writing any batch row**, so they never
enter a batch's membership at all, and `executeUnfollowAction` refuses
them again independently.

## 7. Multiple source attribution lost → fails

**Defect introduced:** added `source_target_profile_ids uuid[]` to
`bluesky_candidates`, the shape that invites read-modify-write.

**Failed (1):** `NC7 — sources are a join table, not an array column on
the candidate`

**Why:** two concurrent imports of overlapping audiences both read the
array, both append, and the second write erases the first's attribution.
A row per `(candidate, target)` with a unique constraint makes an
already-known source a no-op insert instead.

Note the same test asserts the array IS correct on
`bluesky_relationship_actions`, where it is written once at action time
and never updated — so there is no lost-update race there, and freezing
the attribution is the point.

## 8. Workspace scope removed → fails

**Defect introduced:** deleted `.eq("workspace_id", input.workspaceId)`
from `listActionHistory`.

**Failed (1):** `NC8 — EVERY read, update and delete filters on
workspace_id in the query`

The control walks each exported repository function and checks the
operations *that function* performs, rather than counting occurrences
against a threshold — a count can be satisfied by a filter in the wrong
function.

**It caught a real defect while being written:**
`recordCandidateSources` read existing attribution rows filtered only by
`(target_profile_id, candidate_id)`, with no workspace filter. Fixed in
the same commit.

**Why the query and not just RLS:** some callers legitimately pass a
service-role client, which bypasses policies entirely.

## 9. Import marked complete before cursor exhaustion → fails

**9a — length-based completion:** changed `applyPage`'s condition to
`if (page.cursor === null || page.followers.length < limit)`.

**Failed (7)** including `applyPage — does NOT complete on a short page —
the verified 5/3/4 walk` and three `importFollowers` integration tests.

**9b — dropped the database CHECK:** replaced
`check (status <> 'completed' or cursor_exhausted)` with `check (true)`.

**Failed (1):** `NC9 — the database CHECK refuses completed without
cursor_exhausted`

**Why:** measured live, walking `bsky.app` with `limit=5` returned pages
of **5, then 3, then 4**, each with a cursor and 34 million followers
still to come. A length-based rule would have stopped at page one and
reported a complete import. `limit` is an upper bound the provider is
free to undershoot.

## 10. Newly imported candidate silently added to a confirmed batch → fails

**10a — dropped the trigger:** renamed
`create trigger bluesky_relationship_actions_batch_frozen` so it no
longer attaches.

**Failed (1):** `NC10 — a trigger refuses an insert carrying a confirmed
batch id`

Behavioural half, in `execute-actions.test.ts`: `refuses to insert an
action into a confirmed batch` attempts exactly that against the
constraint-enforcing fake, using a DID named `did:plc:newly-imported`.

**10b — let the processor re-query:** added an import of
`listCandidates` into `processBatchActions`.

**Failed (1):** `NC10 — the batch processor takes a fixed list and never
queries for more work`

**Why two layers:** the trigger stops the row from being written; the
structural control stops the processor from acquiring work by any other
means. Either alone would leave the other route open.

---

## Bonus control: the follow record key is read, never computed

Not one of the ten, but the same class of defect and the one most likely
to be introduced by a well-meaning refactor.

`the follow record key is read from the provider, never computed`
asserts that no module transforms a subject DID into an rkey. The
motivating evidence is in the Phase 0 audit: two follow records in a
single provider response used `did_plc_z72i7hdynmk6r22z27h6tvur` and
`zP0yDDN2oUGcWA` — a mangled DID and a TID. Any derivation rule is wrong
for most rows, and because `deleteRecord` is idempotent, a
plausible-but-wrong key removes a different relationship and reports
success.
