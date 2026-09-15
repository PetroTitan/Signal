# Bluesky relationship actions

A narrow module for managing who a Bluesky publishing identity follows.

```
Bluesky profile → import its followers → one deduplicated candidate list
   → select candidates → Follow selected
   → inspect relationship state and history
   → protect the ones that matter → Unfollow selected
```

Reachable at **`/relationships`**, in the sidebar under Publish and in
the mobile More sheet. It requires the `connect_platforms` permission —
the same one that gates connecting an account, because a follow acts as
the operator's account in public.

---

## What it is not

No AI. No scoring, ranking or "recommended to follow". No content
intelligence. No cross-platform abstraction — this is Bluesky only, and
there is no `Platform` interface waiting for X or LinkedIn. No likes,
replies, reposts or DMs. Publishing behaviour is untouched.

And, deliberately, none of the following exists anywhere in the code:

* unattended mass-follow campaigns
* autonomous daily follow quotas
* follow-for-follow churn
* automatic unfollow when someone does not follow back
* human-behaviour simulation or randomised "natural" delays
* rate-limit evasion

Every relationship mutation begins with a person pressing a button. The
`initiator_kind` column admits exactly two values — `operator_single`
and `operator_batch` — so there is no way to *record* a mutation nobody
asked for, let alone perform one.

---

## The operator loop

### 1. Pick the identity

Relationship state is meaningful only relative to one account: "do I
follow this person?" needs a *me*. The identity picker at the top
chooses which Bluesky identity everything below belongs to, and that
identity must be signed in (Accounts → Manage) before any Follow or
Unfollow is possible.

### 2. Add a target profile

Type a handle. Signal resolves it to the account's permanent DID and
stores that. Your typed value is kept verbatim for the audit trail, but
nothing is keyed on it — so if that account renames itself later,
adding it again under the new handle updates the same target rather than
creating a second one.

### 3. Import followers

**Import followers** walks the target's follower list. Progress is saved
after every page, so:

* **Continue** picks up from the exact page it stopped at.
* A failure re-requests the page that failed rather than skipping it.
* Re-running is safe — followers are deduplicated by DID in the
  database, not by a list held in memory.

The status line tells you what is actually true. It says
**"Complete — all N followers imported"** only when Bluesky stopped
returning a pagination cursor. Anything else says "Paused at N" or
"In progress", because a page shorter than the requested limit is not
the end of the list — a measured walk of `bsky.app` returned pages of 5,
then 3, then 4, with 34 million followers still to come.

Large imports pause on their own at a page budget, and pause again when
Bluesky's rate-limit window gets low. Both keep the cursor.

### 4. Work the candidate list

One row per account, ever, however many targets it was found under. Each
row shows its handle and display name, its relationship state, every
target profile it came from, and whether it is protected.

**Relationship states**

| State | Means |
| --- | --- |
| Following | You follow them |
| Mutual | Both directions |
| Follows you | They follow you; you do not follow them |
| Not following | Bluesky answered, and there is no edge |
| **Unknown** | Never checked, **or the check failed** |

**Unknown is not "no".** It is shown in amber for that reason. A
rate-limited or failed lookup lands here and never in "Not following",
because recording an absence you did not observe is how a batch unfollow
becomes a no-op and a batch follow becomes a source of duplicates.
**Check relationship** reads the current truth from Bluesky for whatever
you have selected.

### 5. Follow

Select accounts and press **Follow selected**, or use the Follow button
on a single row. Before anything is sent, Signal verifies you are signed
in, that the identity is yours, that the target is a DID, and that no
other action for the same account is already in flight.

When the follow succeeds, Signal stores the exact record identity
Bluesky returned — the record's URI, key and content hash. That is what
makes a future unfollow safe; see below.

### 6. Protect

**Protect** marks a relationship as one you will not unfollow by
accident. Protected accounts are removed from an unfollow batch *before
any row is written*, so they never enter the approved work at all, and
the executor refuses them again independently. There is no batch
operation that can override it.

### 7. Unfollow

Select and press **Unfollow selected**, or use the row button. Signal
deletes the specific follow record it recorded when you followed.

If it does not have that record's key — an account followed outside
Signal, say — it asks Bluesky for the real one first and then deletes
that. It never constructs a key from the account's ID. Two follow
records observed in a single Bluesky response used completely different
key schemes, so any rule for guessing one is wrong most of the time —
and because deleting is idempotent, a plausible-but-wrong key would
quietly remove a *different* relationship and report success.

Unfollowing someone who still follows you leaves them as **Follows you**,
not **Not following**: removing your edge does not remove theirs.

### 8. History

Every follow and unfollow, permanently. An unfollow *adds* a record; it
does not retract the follow that preceded it. Each entry keeps the
handle as it appeared **at the time you acted**, so an account that has
since renamed is still listed under the name you saw.

---

## When Bluesky does not answer

This is the part worth understanding, because it is where the module
behaves differently from what you might expect.

If Signal sends a follow and the connection drops, or Bluesky returns a
server error, **the outcome is genuinely unknown** — the request may
have been applied and only the *response* lost. Signal does not send it
again. Creating a follow is not idempotent: a retry of a request that
actually worked leaves two follow records for one account, one of which
Signal has no record of and could never clean up.

Instead it reads the relationship from Bluesky and records what it saw:

* **The follow exists** → the action succeeded. Which attempt created it
  does not matter; the desired state holds, and the record's key is
  captured so a future unfollow will not have to ask.
* **The read also failed** → still unknown. Nothing is claimed and
  nothing is re-sent.
* **The follow is not there** → recorded as **reconciliation required**,
  and *not* as a failure. Bluesky's read API indexes writes with a
  delay, so a successful write can read back as absent for a short
  window. Signal cannot tell that case from a genuine failure, so it
  shows you what it observed and leaves the next move to you.

The same applies to unfollow. Deleting is idempotent, so a repeat would
be harmless in itself — but an automatic loop that re-derives its target
is exactly how the wrong record gets deleted, so both paths go through
the same gate.

A banner tells you how many actions are in this state; History shows
what each one observed.

---

## Batches

Confirming a batch **freezes its membership**. The accounts you selected
are written as rows, the batch is marked confirmed, and from that moment
the database refuses to attach anything else to it — an import that
finishes mid-run cannot sweep new accounts into work you already
approved.

A batch tracks requested, processed, succeeded, failed, and
reconciliation-required. If Bluesky starts rate-limiting, or the session
expires, the batch **stops** and keeps its progress rather than pushing
through. Requests inside a batch are evenly spaced by a fixed interval —
fixed, not randomised, because the point is to stay comfortably inside a
published limit rather than to make the traffic look like something it
is not.

---

## For agents (MCP)

Three read-only tools:

| Tool | Answers |
| --- | --- |
| `signal.bluesky.relationship_targets` | Which profiles are being imported, and how far each import actually got |
| `signal.bluesky.relationship_summary` | How the candidate corpus breaks down by state; what needs reconciliation |
| `signal.bluesky.relationship_history` | The audit trail, optionally for one DID |

There are **no relationship write tools**, deliberately. A follow acts
as your account in public, and "explicitly initiated by the operator" is
not a property a tool call can carry.

Each response repeats the warning that `unknown` means never-checked or
a failed lookup, never "not following" — the single most consequential
thing to get wrong about this data.

---

## Related documents

- `production-runbook.md` — the operational runbook (2026-09-16): pre-flight
  queries, migration order, rollback and kill switch, supervised dry runs
  and canaries, reconciliation verification, exact queries.
- `canary-followup-2026-09-15.md` — the nine defects the 2026-09-15 canary
  surfaced: root causes, negative controls, fixes, evidence.


* [`phase-0-audit.md`](./phase-0-audit.md) — what the AT Protocol
  actually does, measured against the live API, and why each design
  decision follows from it.
* [`negative-controls.md`](./negative-controls.md) — the ten invariants,
  the defect introduced to test each one, and the tests that caught it.
