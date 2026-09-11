# Phase 0 — Bluesky relationship actions: audit findings

Baseline: `origin/main` = `c47e31b53778188e99893f224532b86e8ed713f0`
(merge of PR #177, "Social Content Strategy intelligence").
Working tree clean, no untracked files. `npx tsc --noEmit` clean;
`npx vitest run` = 223 files / 4219 tests passing.

This document records what already exists, what the AT Protocol
actually does (verified against the live API, not from memory), and
which of those facts constrain the design. It was written **before**
any feature code.

---

## 1. What Signal already has

### 1.1 Bluesky authentication and session handling

Signal does **not** use `@atproto/api`. Every Bluesky call is plain
`fetch` against documented XRPC endpoints. That decision is stated
explicitly in `src/core/publishing/publish-bluesky.ts`, and the
relationship module keeps it — adding the SDK now would introduce a
second, competing auth lifecycle next to the one below.

Auth is **app-password → session JWT**, not OAuth:

| Concern | Location |
| --- | --- |
| Sign-in (`com.atproto.server.createSession`) | `src/core/identity-verifiers/bluesky-session.ts` |
| Session refresh (`com.atproto.server.refreshSession`) | same file, `refreshBlueskySession` |
| Persisting the session | `src/core/identity-verifiers/bluesky-session-persistence.ts` |
| Connect route | `src/app/api/identity/[identityId]/bluesky/connect/route.ts` |
| Handle/DID normalisation | `src/core/identity-verifiers/bluesky-resolve.ts` |

Properties worth preserving:

* `createSession` returns `{ did, handle, accessJwt, refreshJwt }`.
  The **DID is treated as the identity**; the handle is only checked
  against the operator's declared handle to refuse a wrong-account
  connection.
* JWTs are encrypted with `TOKEN_ENCRYPTION_KEY` (AES-256-GCM, the
  same cipher OAuth tokens use) *before* they reach the repository.
  Plaintext never enters an upsert plan, a log line, or a response
  body.
* `refreshSession` authenticates with the **refresh** JWT as the
  bearer, not the access JWT.
* There is no background re-sign-in anywhere. Refresh happens at most
  once per operation, driven by a 401.

### 1.2 The reusable session lifecycle

`src/core/publishing/bluesky-publish-orchestrator.ts` is the only
place that turns a stored connection into a usable `(did, accessJwt)`.
Its shape is exactly what relationship mutations need:

1. Load the identity (`getAccountById`) and assert `platform === "bluesky"`.
2. Load the per-identity connection row
   (`getConnectionForAccount(workspaceId, accountId, "bluesky")`).
3. Require `hasAccessToken`, a healthy-enough `connection_status`, and
   an available cipher.
4. `readEncryptedTokens` → `decryptForOutboundUse` → plaintext access
   JWT held **only in that stack frame**.
5. Call the provider. On `session_expired`, refresh **exactly once**,
   re-check the handle for drift, persist the new tokens, retry once.
   Never recurse, never refresh twice.
6. On refresh failure, mark the connection expired and stop.

That logic is currently **inlined in the publish orchestrator and
coupled to `PublishOutcome`**. The relationship module must not import
the publisher, and must not fork the lifecycle either. Decision:
extract the lifecycle into a publish-agnostic helper
(`core/bluesky-relationships/session.server.ts`) that hands a caller a
`(did, handle, accessJwt)` plus a `refreshOnce()` continuation, and
leave the publish orchestrator untouched.

### 1.3 Authorisation

* Route/action auth: `createSupabaseServerClient()` →
  `supabase.auth.getUser()` → `getPrimaryWorkspace()` → row lookups
  always scoped by `workspace_id`.
* Roles are **not** a linear hierarchy in practice: `reviewer` can
  `approve_content` but cannot `connect_platforms`, while `editor` can
  `edit_content` but also cannot `connect_platforms`. Gating must use
  `can(role, permission)` from `src/core/teams/permissions.ts` and
  never `role >= something`.
* `src/core/navigation/route-manifest.ts` is the single source of
  truth for navigation and has a guard test that walks the App Router
  tree — **a new page route that is not classified there fails the
  build's test suite.** The manifest's own comment is explicit that
  hiding a nav entry is not security.

### 1.4 Audit / history infrastructure

* `activity_events` + `recordActivity` / `recordSystemActivity`
  (`src/repositories/activity-repository.ts`) — workspace timeline,
  never throws, best-effort.
* `publish_history` — publishing-specific, with its own `mode` check
  constraint. The brief requires relationship actions to be a
  **separate subsystem from publishing execution**, so relationship
  mutations get their own tables rather than overloading this one.

### 1.5 Schema conventions

Migrations are additive, `set search_path = public`, RLS via
`public.is_workspace_member(workspace_id)`, `touch_updated_at`
triggers, and no `DELETE` policy where the row is an audit record.
`src/lib/supabase/types.ts` carries hand-written `Row`/`Insert` types
plus a `Database` map.

### 1.6 Existing relationship / follow code

**None.** `grep` finds no follow/unfollow/relationship code anywhere in
`src/`. `account_snapshots` records a *follower count* but no graph
edges. This milestone is greenfield inside an existing app.

---

## 2. AT Protocol semantics — verified live, not assumed

All of the following was executed against the live API on
2026-09-11 during Phase 0. Reads only; **no relationship was created
or deleted**.

### 2.1 Profile resolution

```
GET https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=bsky.app
→ {"did":"did:plc:z72i7hdynmk6r22z27h6tvur"}

GET .../xrpc/app.bsky.actor.getProfile?actor=bsky.app
→ { did, handle, displayName, avatar, description,
    followersCount, followsCount, postsCount, createdAt, indexedAt, … }
```

`getProfile` accepts **either** a handle or a DID as `actor`, and
returns the canonical DID either way — so resolution and metadata are
one call, not two.

Failure shapes (both HTTP 400, not 404):

```
resolveHandle(nonexistent) → 400 {"error":"InvalidRequest","message":"Unable to resolve handle"}
getProfile(nonexistent)    → 400 {"error":"InvalidRequest","message":"Profile not found"}
```

### 2.2 Handles are not identity — evidenced

The very first follower returned by `app.bsky.app`'s follower list is:

```json
{ "did": "did:plc:sdo6kumfbnroeho6zllkzc2z", "handle": "handle.invalid", … }
```

`handle.invalid` is a **real value the API returns** when a DID's
handle cannot be verified. A handle is therefore not merely unstable,
it is not even guaranteed to be well-formed. DID is the only durable
key. This is the direct justification for negative control #1.

### 2.3 Follower listing and pagination

```
GET .../xrpc/app.bsky.graph.getFollowers?actor=<handle|did>&limit=<1..100>[&cursor=…]
→ { subject, followers: [ProfileView], cursor? }
```

Verified behaviours, each of which shapes the import design:

* **`limit` is a maximum, not a promise.** Walking `bsky.app` with
  `limit=5` returned **5, then 3, then 4** followers on consecutive
  pages. A short page does **not** mean the list is exhausted.
  → *Completion is defined by the absence of `cursor`, and by nothing
  else.* (Negative control #9.)
* `limit=101` → `400 InvalidRequest … maximum 100`.
* An **invalid cursor does not error**. `cursor=garbagecursor`
  returned HTTP 200 with results. Cursors are opaque and are only ever
  trusted when they came from the provider; a locally-synthesised
  cursor would silently produce wrong data rather than fail.
* The response carries no total count, so import progress is
  "discovered so far", never "N of M".

### 2.4 Relationship lookup

```
GET .../xrpc/app.bsky.graph.getRelationships?actor=<did>&others=<did>&others=<did>…
```

* `others` is capped at **30**; 31 → `400 … array too big (maximum 30, got 31)`.
  Verified by binary probe, not read from docs.
* Each result is a union of `#relationship` and `#notFoundActor`.
* `#relationship` has **`did` as its only required field**. `following`
  is present *only if the actor follows that DID*, and its value is the
  **AT-URI of the follow record**. `followedBy` is the mirror.
* An unknown DID returns `{"did": "did:plc:aaaa…", "$type": "…#relationship"}`
  — an object with neither key. So *"key absent" means no edge*, but
  only when the object came back at all. A DID **missing from the
  response array**, or a transport/HTTP failure, means **unknown** and
  must never be flattened into `not_following`. (Negative control #3.)
* Does **not** require auth, and does **not** return a CID for the
  follow record — only the URI.

### 2.5 Follow records: URI / rkey / CID

A real record, fetched with `com.atproto.repo.getRecord`:

```json
{
  "uri": "at://did:plc:mwvlqlznk5sumbuhkf6s7dvm/app.bsky.graph.follow/did_plc_z72i7hdynmk6r22z27h6tvur",
  "cid": "bafyreidyr4q6fyd4kianxvfijdmiix4gehqpjjn44iiiixlgnfiwlgvwoi",
  "value": { "$type": "app.bsky.graph.follow",
             "subject": "did:plc:z72i7hdynmk6r22z27h6tvur",
             "createdAt": "2026-07-16T08:55:14.029Z" }
}
```

The AT-URI is `at://<follower did>/app.bsky.graph.follow/<rkey>`.

**The rkey is not derivable.** Two follow records observed in the same
response used entirely different schemes:

* `did_plc_z72i7hdynmk6r22z27h6tvur` — a mangled subject DID
* `zP0yDDN2oUGcWA` — a TID

Any code that computes an rkey from the subject DID will delete the
wrong record or nothing at all on the majority of rows. The rkey is
read from the provider — from the `createRecord` response at follow
time, or from `getRelationships().following` at reconcile time — and
never constructed.

### 2.6 Follow creation

```
POST <pds>/xrpc/com.atproto.repo.createRecord
  { repo: <operator did>, collection: "app.bsky.graph.follow",
    record: { $type, subject: <target did>, createdAt } }
→ { uri, cid, … }   (uri and cid are both required in the lexicon output)
```

**`createRecord` is not idempotent.** It mints a new rkey per call, so
calling it twice for the same subject creates two live follow records
pointing at the same account. This is precisely why an ambiguous
outcome may not be retried blindly (negative controls #2 and #4): a
timeout on a request that actually succeeded, retried, leaves a
duplicate that the local database has no record of.

### 2.7 Unfollow

```
POST <pds>/xrpc/com.atproto.repo.deleteRecord
  { repo, collection, rkey }
```

The lexicon description is *"Delete a repository record, **or ensure it
doesn't exist**"* — deletion **is** idempotent. Deleting an
already-deleted record is a success, not an error. That makes the
*danger* of unfollow the opposite of follow's: not duplication, but
deleting the wrong record because the rkey was guessed. Hence: never
guess; reconcile first when local record identity is missing.

`swapRecord` (a CID compare-and-swap) is optional. Storing the CID
from `createRecord` lets a future unfollow assert it is deleting the
record it created.

### 2.8 Rate limits

The PDS (`bsky.social`) returns real limit headers on XRPC calls:

```
ratelimit-limit: 3000
ratelimit-remaining: 2999
ratelimit-reset: 1789123613      # unix seconds
ratelimit-policy: 3000;w=300
```

The public AppView (`public.api.bsky.app`) returned **no** such headers
on a successful read.

Design consequences:

* Mutations read these headers and the batch **stops on its own**
  before the limit is reached, persisting progress.
* Reads go to the AppView so that importing followers never spends the
  operator's write budget.
* On `429` the batch pauses and records why. It does not retry in a
  tight loop, and it does **not** insert randomised "human-like" delays
  — that would be disguising automation, which this milestone
  explicitly refuses to do. A fixed, declared inter-request spacing is
  used instead.

### 2.9 AppView lag — a real constraint on reconciliation

`getRelationships` is served by the AppView, which indexes the PDS
asynchronously. A follow that has just been written may not appear
there immediately.

This is why "ambiguous outcome → reconcile" **does not** conclude with
an automatic second mutation. If the reconcile read says *not
following*, that could mean the write failed **or** that the AppView
has not caught up. Signal cannot distinguish the two, so it records
`reconciliation_required` with what it observed and leaves the next
mutation to an explicit operator decision. Claiming to know which case
it is would be a fabrication, and acting on the guess is exactly the
blind retry the brief prohibits.

---

## 3. Design decisions that follow

1. **DID is the primary key** of a candidate; handle is mutable
   metadata refreshed on every sighting.
2. **Import completion is cursor-exhaustion**, stored as a distinct
   state from "in progress"; a short page is not completion.
3. **Relationship state has a real `unknown`**, and provider failure
   maps to `unknown`, never to `not_following`.
4. **Follow persists `uri` + `rkey` + `cid`** from the provider
   response. Unfollow refuses to run without an rkey and reconciles
   first.
5. **Batches are immutable in membership**: members are snapshotted as
   rows at confirmation time, so a later import physically cannot add
   to a confirmed batch.
6. **History is append-only** and separate from current relationship
   state.
7. **Reads use the AppView, writes use the PDS.**
8. Relationship code shares the *session lifecycle* with publishing but
   nothing else — no `PublishOutcome`, no publish tables, no scheduler.

## 4. Untouched by design

Publishing, the scheduler, weekly plans, weekly contracts, creatives,
metrics/measurement, the strategy layer, X/LinkedIn/Reddit/dev.to/
Hashnode/Telegram adapters, and every existing migration.
