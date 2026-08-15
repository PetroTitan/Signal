# Publishing UX architecture — destinations, title contract, operator surfaces

Status: current as of the `feat/publishing-ux-mobile-operations` milestone.
Baseline audited: `origin/main` @ `c7961c2`.

This document records three contracts that had drifted apart, the runtime
truth behind each, and the decisions taken. It is written to be read by
whoever next changes the editor, the scheduler allowlist, or the approval
gate — the recurring defect in this codebase is *a rule corrected on one
path and left divergent on its siblings*, so each contract below names its
single decision function.

---

## 1. Platform capability vs. item destination

### The four concepts, kept apart

| Concept | Question it answers | Where it lives |
|---|---|---|
| **Platform capability** | What does Signal know how to adapt, validate, publish by API, or prepare for manual publication? | `platform-guidance.ts` (editorial) + `publish-capability-registry.ts` (executable) + the platform-native adapters |
| **Item destination** | Where is *this* item intended to go? | `weekly_plan_items.platform` — one value, chosen in the editor's **Where** selector |
| **Connection state** | Does this workspace have a usable identity/credential for that platform right now? | `platform_connections` rows |
| **Publishing mode** | API/autonomous, or operator-driven manual distribution? | Derived — never stored |

These were conflated. "Publish destinations" (the adapt-for chip row) is
**capability context**: it lists what Signal can shape content for. "Where"
is **the item's destination**. They are different questions and must not
share a widget, a label, or a list.

### Root cause of the four-platform "Where"

`founder-compose-sheet.tsx` carried a local literal:

```ts
const PLATFORM_CHOICES = [
  { value: "reddit",   label: "Reddit",   short: "r/"  },
  { value: "devto",    label: "dev.to",   short: "dev" },
  { value: "hashnode", label: "Hashnode", short: "Hn"  },
  { value: "bluesky",  label: "Bluesky",  short: "Bs"  },
];
```

imported from nothing, filtered by nothing. It was correct when written and
never moved again. X and Telegram subsequently gained real publishers and
entered `SCHEDULER_AUTONOMOUS_PLATFORMS`, and the editor could not see it.

**It could not see it for a structural reason, not an oversight.** Capability
truth was declared inside `publishing-runner.ts` and `publishing-scheduler.ts`,
both of which begin `import "server-only"`. The compose sheet is a client
component. There was no way for it to ask the question, so it answered from
memory.

Two further consequences were live defects, not just staleness:

- An item already on `telegram` / `x` / `linkedin` rendered **zero selected
  chips**, and any click silently rewrote `platform` to one of the four —
  editing such an item destroyed its destination.
- The same stale four-value literal is duplicated as the weekly-contract
  scope selector (`weekly-contracts/page.tsx`), so a Telegram or X item can
  never be brought into contract scope from the UI and is skipped by bulk
  approve with "platform out of contract scope".

### Decision: move the declaration, do not copy it

`src/core/publishing/publish-capability-registry.ts` is a **pure** module and
is now the single declaration site for `PLATFORMS_WITH_REAL_PUBLISHER` and
`SCHEDULER_AUTONOMOUS_PLATFORMS`. `publishing-runner.ts` and
`publishing-scheduler.ts` re-export them unchanged, so every existing import
— including the P0.3 invariant test — keeps guarding exactly what it guarded
before.

`src/core/publishing/publish-destinations.ts` derives the editor's model from
that registry plus `FOUNDER_PLATFORMS` plus connection rows the page already
loads. It introduces **no new platform list**.

```
resolvePublishDestinations({ identities, connections }) -> PublishDestination[]
```

`autonomousSchedulable` is computed only by `isAutonomouslySchedulable()`,
which is the AND of both capability sets. Not from the editor's list, not
from connection state, not from `publishingMode`. When the editorial
`publishingMode: "api"` and capability truth disagree, **capability truth
wins** — an editorial "api" claim with no real publisher is precisely the
false capability P0.3 removed.

### Resulting destination matrix

| Platform | Real publisher | Scheduler autonomous | MCP schedulable | Connection model | **Where** shows |
|---|---|---|---|---|---|
| reddit | yes | yes | yes | per-identity OAuth | connected / connection required |
| bluesky | yes | yes | yes | per-identity app password | connected / connection required |
| devto | yes | yes | yes | per-identity API key | connected / connection required |
| hashnode | yes | yes | yes | per-identity API key + publication id | connected / connection required |
| telegram | yes | yes | yes | workspace bot token + per-identity chat id | connected / connection required |
| x | yes | yes | **no** (deliberate) | per-identity OAuth 2.0 | connected / connection required |
| linkedin | no (stub) | no | no | OAuth callback unimplemented | manual |
| youtube | no | no | no | none (DB CHECK forbids a connection row) | manual |
| threads | no | no | no | none (DB CHECK forbids) | manual |
| instagram | no | no | no | none (DB CHECK forbids) | manual |
| indie_hackers | no (not even a `PublishPlatform`) | no | no | none | manual |

MCP remaining narrower than the scheduler for `x` is deliberate and pinned by
`platform-capability-truth.test.ts`. Narrower is always allowed; wider never is.

### Why manual destinations are visible but not schedulable

Selecting a manual platform and scheduling it was already reachable before
this milestone (`adaptPlanItemForPlatformAction` offers `linkedin`, `x` and
`telegram` as adapt targets, and MCP `prepare_item` accepts any string).
Traced end to end, the result was:

1. draft, send-for-approval, approve and schedule — **all pass**; no gate
   anywhere consults the platform;
2. `createExecutionItem` succeeds, the row walks to `scheduled`;
3. the tick hits the `SCHEDULER_AUTONOMOUS_PLATFORMS` allowlist and persists
   `blocked` / `platform_not_supported`;
4. the plan item mirrors to `paused`, whose compose footer offers
   **"Schedule retry"**, which mints a *fresh* execution item (the retry
   firewall correctly permits it — nothing was published) and returns to 3.

An unbounded loop of blocked execution items with no operator exit, while
`/execution/items/[id]` displays *"this post is still waiting for its
scheduled time; the publish controls unlock here"* — which can never happen,
because `execution_items.status = 'ready'` has exactly one writer in the
repository (`markItemReadyForPublish`, reachable only under
`SAFE_TEST_MODE && platform === "reddit"`). The whole manual-distribution UI
is unreachable for LinkedIn / YouTube / Threads / Instagram / X today.

**Decision.** Manual destinations are legitimate — preparing and adapting
content for them is a first-class workflow, and hiding them is what produced
the four-entry list. So they are **selectable and clearly labelled Manual**,
and the autonomous-scheduling path refuses them at the server action:
`approvePlanItemAndScheduleAction` and `scheduleApprovedItemAction` now
decline to create an execution item for a non-autonomous platform, with copy
naming the manual path. This is a strict tightening — it removes an existing
route to a guaranteed-dead item and cannot widen anything.

Building the `scheduled → ready` transition that would make manual
distribution reachable is **out of scope for this milestone** and recorded in
§5.

### Telegram: one identity is one target

`platform_connections.provider_account_id` holds the canonical `chat.id`
written by the verify route; `metadata.telegram_target_type` records
`channel | group | supergroup`. `resolveSchedulerTarget` gives
`execution_items.metadata.target` **precedence over** `provider_account_id`.

The compose sheet sent its `subreddit` field on **every** autosave regardless
of platform, and `composeUpsertDraftAction` wrote it to
`metadata.target` for every platform. `draft.subreddit` defaults to
`allowedSubreddits[0] ?? "test"`. So opening any Telegram item in the editor
and typing one character stamped `metadata.target = "test"` onto it.

That is inert today only because no `createExecutionItem` call site copies
plan-item `metadata.target` onto the execution item (see §5, defect D1) — the
moment anything propagates it, Telegram publishes into a chat named `"test"`.

**Decision.** `allowsOperatorTarget(platform)` gates the write. Only Reddit
takes an operator-typed routing target; every other destination resolves its
target from the identity. The editor no longer sends the field for other
platforms, and the action ignores it for them.

---

## 2. Title contract

### Root cause of the universal requirement

There was no single rule — there were four platform-blind gates, of which one
was the real chokepoint:

| Gate | Location | Scope |
|---|---|---|
| `sendForApprovalAction` | `weekly-plan/_actions.ts` | universal — the compose modal's only route out of `draft` |
| `deriveComposeActionState` | `compose-action-state.ts` | universal — mirrors the above in the footer |
| `createPlanItemAction` | `weekly-plan/_actions.ts` | universal |
| `updatePlanItemAction` | `weekly-plan/_actions.ts` | universal — forbids *clearing* a title |
| MCP `prepare_item` / `update_item` | `mcp/schemas.ts`, `tool-input-schemas.ts` | universal |
| `computeContinueWritingMissingParts` | `_plan-item-warnings.ts` | universal (advisory) |
| `_publish-tier-one-action.ts` | execution detail | **wrong** — blocked Bluesky, which needs no title |

Meanwhile the *publishers* had always been platform-aware. Only three refuse
without a title, and they refuse unconditionally:

- `publish-reddit.ts` → `missing_title`
- `publish-devto.ts` → `article_title_required`
- `publish-hashnode.ts` → `hashnode_title_required`

X, Bluesky, Telegram, Threads and Instagram never read `request.title` at
all. `transformers/x.ts` and `transformers/bluesky.ts` document that the
title is deliberately **not** prepended to the body; `transformers/telegram.ts`
reads only `bodyMarkdown`. So the universal rule was making operators invent
strings that would never be published.

The declarative `requiresTitle` flag on each platform-native adapter was
already correct — and read by **zero** production files.
`validateShapeAgainstCapabilities` cannot enforce it: `PlatformNativeShape`
carries no title field. The adapters' `buildPreview()` title blockers are
real logic but display-only (one caller, the read-only shape summary).

### Decision: one predicate, in the module that already owns approval policy

`requiresTitle({ platform, contentType, intent })` lives in
`src/core/platform-native/approval-policy.ts`, beside the `requiresCreative`
predicate it mirrors. That module is pure, has no `server-only` import, and is
already imported by both server actions and client components — the placement
constraint that matters.

| Platform | Object | Title |
|---|---|---|
| reddit | post / link_post / media_post / article / legacy-null | **required** |
| reddit | comment / reply | optional |
| devto | any | **required** |
| hashnode | any | **required** |
| linkedin | article | **required** |
| linkedin | anything else | optional |
| youtube | video_post / short_video | **required** |
| youtube | anything else | optional |
| x, bluesky, telegram, threads, instagram, indie_hackers | any | optional |
| *no destination chosen yet* | any | optional |

Default is **optional**. Adding a platform must not silently reinstate the
universal rule.

Reddit / dev.to / Hashnode are required even for legacy rows carrying
`intent = "unknown"`, because their publisher gates are unconditional.
Approving such an item would only move the failure later, into a terminal
publish failure the operator has to recover from.

### Backward compatibility

**No migration.** Every post-bearing table already declares `title text`
nullable with no `CHECK` and no `DEFAULT`:

```sql
-- supabase/migrations/20260522010001_phase_d_schema.sql:37
title text,
-- supabase/migrations/20260522050001_phase_e2_execution_schema.sql:79
title text,
```

The TS row types are already `string | null`; all four repositories already
write `title: input.title ?? null`; `composeUpsertDraftAction` already
persists `NULL` on clear. Existing titled records are untouched — the change
is removal of gates, not rewriting of data. The NOT NULL `title` columns that
do exist (`weekly_plans`, `execution_queues`, `activity_events`,
`notifications`, `weekly_approval_contracts`, `operator_bridge_requests`) are
container/audit rows that are never populated from a post's title and already
carry unconditional server-side defaults.

### Derived display label — and why it cannot be published

`src/core/publishing/plan-item-label.ts` returns, in order: a real title →
the first meaningful fragment of the body → `"<Platform> post"` →
`"Untitled post"`. It is **display-only** and never persisted.

Three independent reasons a derived label cannot reach published content:

1. It is never written to `weekly_plan_items.title` or
   `execution_items.title`, and never enters a `PublishRequest`.
2. The publishers that *use* a title refuse without a real one; the ones that
   don't refuse never read the field.
3. `title-contract.test.ts` asserts by filesystem scan that no publisher,
   transformer, adapter, or scheduler module imports the label module.

Point 3 matters because two title consumers are not obvious:
`transformers/hashnode.ts` derives the published URL slug from the title, and
`publish-fingerprint.ts` hashes it into the 30-day duplicate fingerprint.
Both are on platforms that require a real title, so the derived path never
reaches them — but the static guard is what keeps that true.

---

## 3. Navigation hierarchy and the design system

### `btn-secondary` never existed

31 call sites reference `.btn-secondary`. It is defined nowhere: not in
`globals.css` (the repo's only stylesheet), not in `tailwind.config.ts`
(`plugins: []`), and it appears zero times in the compiled stylesheet.

Tailwind Preflight is more aggressive than the UA sheet, so those elements
rendered as **bare body text** — no border, no padding, no background, no
link colour. Affected: eight "Sign out of this account" disconnects, "Revoke",
"Pause queue", "Cancel queue", "Reject", "Cancel request", three
"Approve & hold" CTAs (including a full-width primary approval button), and
the three "← back to index" links on the contract / queue / bridge detail
pages.

Defining the class repairs all 31 with zero TSX edits.

The `danger` prop in four lifecycle controls selects `btn-secondary` — so
`danger` had come to mean "not the primary CTA", and was being passed for
**"Activate"** and **"Dry-run"**. Real destructive controls move to
`.btn-danger`; those two stay neutral.

### Focus indicators failed WCAG 1.4.11 everywhere

`.btn` applies `focus:ring-signal-300`, which beats the global
`:focus-visible` rule on specificity (`.btn:focus` = 0,2,0 vs
`button:focus-visible` = 0,1,1). signal-300 on white is **2.568:1**. The
global rule that the remaining controls fall back to composites signal-500 at
45% alpha to `rgb(154 180 238)` — **2.072:1**. Both fail the 3:1 threshold;
no focus indicator in the app passed.

Raising the ring to signal-500 and the global ring to full opacity gives
**6.076:1** across every control, without touching a `.tsx` file.

### Contrast used by the new classes

| Pair | Ratio |
|---|---|
| white on signal-600 | 7.99:1 |
| signal-800 on signal-50 | 10.87:1 |
| signal-700 on white | 9.11:1 |
| signal-700 on ink-50 (page bg) | 8.56:1 |
| red-700 on white | 6.47:1 |
| white on red-600 | 4.83:1 |

Never white on signal-400 or below; never signal-300 as a ring.

### Semantic assignment

| Role | Class | Treatment |
|---|---|---|
| Primary navigation (moves the operator to another screen) | `.btn-nav` | signal-50 fill, signal-300 border, signal-800 text, signal-600 border on hover |
| Primary in-place action | `.btn-primary` *(unchanged)* | solid signal-600 |
| Secondary action | `.btn-secondary` *(newly defined)* | neutral white/ink |
| Destructive | `.btn-danger` / `.btn-danger-solid` | red outline / solid red for typed confirmation |
| Inline navigation link | `.nav-link` | signal-700, underline on hover |
| Active nav row | `.nav-item-active` | signal-50 / signal-800 |

Navigation gets a *distinct* blue rather than a second solid fill, so a screen
can carry one action CTA and one navigation CTA without two identical blue
buttons. Status pills and platform chips keep their own semantics and are
untouched — a chip is not a button.

---

## 4. Mobile operator surfaces

Verified against build artifacts, not inferred:

- **Safe-area handling was dead code.** Three components used
  `env(safe-area-inset-bottom)`, but the app never emitted
  `viewport-fit=cover`; the built HTML carried only
  `width=device-width, initial-scale=1`. Without it, `env()` resolves to
  `0px`. One `export const viewport` in `app/layout.tsx` activates all three.
- **There was no bottom nav.** `MobileNav` sat in normal document flow, so
  reaching navigation on `/weekly-plan` meant scrolling past every card.
- **The compose body is ~1.7 screens tall collapsed** (~1200–1400px against
  an ~810px budget at 430×932, ~380px with the keyboard up), and ~250–300px
  of that is informational (`PlatformShapeSummary`, the preview tab strip,
  the metadata tab) sitting *between* the operator and the footer.
- **The primary schedule commit button was stranded** ~700–900px down the
  scroll, inside the "When" section, while the already-pinned footer received
  `scheduleSet` as a prop and rendered only the text "Set a schedule time
  above first".
- **Horizontal overflow propagates.** The compose body is
  `overflow-y-auto`, so per CSS Overflow its other axis computes to `auto` —
  any over-wide child pans the *entire* body, dragging Title/Where/When
  off-screen together. Real offenders: the preview tab strip (overflows at
  every phone width for reddit/dev.to/Hashnode), `PlatformShapeSummary` rows
  rendering un-broken URLs, and five `max-w-xs` error spans that clip the
  approval-failure reason at ≤352px — the operator saw a failed approve with
  no reason.
- **The reschedule popover used `position: fixed` with `top: auto`**, so it
  rendered under its trigger and then detached from the page on scroll.
- **Nothing in the app reached 44px.** The tallest control measured ~38px;
  the smallest, the creative Remove/Skip button, ~21px.

Ordering principle applied to the editor: **Content → Destination → Schedule →
Creative/validation → Approval**, with capability/debug information collapsed
so it cannot dominate the action path. Nothing critical is hidden; the
collapsed sections are informational summaries whose blockers still surface.

---

## 5. Known defects found but deliberately NOT fixed here

**D1 — `execution_items.metadata.target` is never populated.**
`composeUpsertDraftAction` stores the subreddit at
`weekly_plan_items.metadata.target`, but none of the four `createExecutionItem`
call sites copies it onto the execution item. So `resolveSchedulerTarget`
returns `null` for Reddit and the runner refuses with `missing_subreddit` —
terminal `failed`, plan item `paused`. Masked in practice only by
`SAFE_TEST_MODE`, which diverts Reddit to the courier path before
`publishOne`.

**RESOLVED** (`feat/publishing-truth-cleanup`) — with the safety consequence
handled explicitly. The target is threaded by one helper spread into every
execution-item creation site, gated on `allowsOperatorTarget` so it cannot
override Telegram's identity-bound chat id, and pinned by a static test so a
new creation site cannot silently reopen it.

Because that revives a path which had been fail-closed since it was written,
and revives it into a place with none of the manual path's protections, the
runner now requires `REDDIT_AUTONOMOUS_PUBLISH=true` AND the resolved subreddit
to be in `ALLOWED_TEST_SUBREDDITS` before calling the provider. Unset — the
default, and production today — means no autonomous Reddit provider call, so
landing the fix changed no production behaviour. See §6.

**D2 — RESOLVED** (`feat/publishing-truth-cleanup`). `prepareForManualDistributionAction`
walks a manual item `pending_authorization → authorized → ready →
ready_for_manual_publish`; every edge was already legal and the status was
already in the DB CHECK, so no migration. It never routes through `scheduled`,
which is what keeps the item invisible to the tick. A second defect surfaced
while fixing it: `recordManualDistributionAction` transitioned straight to
`completed`, which is not an edge from either `ready` or
`ready_for_manual_publish`, and `updateItemStatus` throws on an illegal
transition — so the action could never have succeeded. It now walks through
`running`, as the Reddit manual-record path already did.

**D3 — RESOLVED** (`feat/publishing-truth-cleanup`). `isDistribution` derives
from `isAutonomousDestination`. `isTierOne` deliberately does NOT: it is a
credential question (dev.to / Hashnode / Bluesky publish with API-key
credentials and therefore offer an operator "publish now" button), not an
autonomy question — Reddit and X are equally autonomous and have no such
button.

**D4 — RESOLVED** (`feat/publishing-truth-cleanup`). Reddit reports like every
other API platform, deriving readiness from the same provider-env-plus-token-
encryption AND that `/settings/publishing-platforms` uses. The manual copy is
retained and made conditional: while `REDDIT_OAUTH_STATUS` holds the workspace
at API approval, "Manual — API approval pending" is the truthful answer.

**D5 — RESOLVED** (`feat/publishing-truth-cleanup`). `prepare_item` validates
`platform` against the same derived `FOUNDER_PLATFORMS` allowlist
`accounts.prepare` uses, refusing with `platform_unsupported`. Both surfaces —
the hand-rolled parser and the declared JSON Schema — are fixed and pinned to
each other. Preparation deliberately accepts manual platforms; it says nothing
about schedulability, which is still gated by `SCHEDULABLE_PLATFORMS`.

**D6 — the weekly-contract scope selector** duplicates the stale four-platform
literal, so Telegram and X items cannot be brought into contract scope from
the UI. Fixed in this milestone by deriving it from capability truth; noted
here because the same literal may exist elsewhere.

**D7 — residual mobile items**: 109 form controls below 16px still trigger iOS
focus zoom; the calendar grid crushes to ~44px per day column at 430px; ~20
pages use the legacy `px-6` base padding instead of `px-4`; no modal locks
background scroll.


---

## 6. Autonomous Reddit publishing — operator QA

Threading the routing target (§5, D1) revived the scheduler's Reddit path. It
is gated, and turning it on is a deliberate operator action.

**Default state — nothing to do.** With `REDDIT_AUTONOMOUS_PUBLISH` unset, the
scheduler never calls Reddit. A scheduled Reddit item resolves its subreddit,
reaches the runner, and is refused with `reddit_autonomous_publish_disabled`
(terminal `blocked`, no retry budget consumed). This is byte-identical in
outcome to production before the fix, which refused with `missing_subreddit`
— the difference is that the reason is now honest and the operator is told at
approval time if a subreddit is missing at all.

**The manual path is unaffected.** `/execution/items/[id]` calls
`publishToReddit` directly with the subreddit typed into the form. It does not
go through the runner and is not gated by any of this.

**To enable autonomous Reddit publishing:**

1. Confirm the Reddit identity is connected and its token carries the `submit`
   scope. The scope is requested only while `SAFE_TEST_MODE=true` at connect
   time and is frozen into the token — a token minted without it will reach
   Reddit and get a 403 (`platform_unauthorized`), which is a real outbound
   request that creates no post.
2. Set `ALLOWED_TEST_SUBREDDITS` to the subreddits Signal may post to. The
   scheduler will refuse anything else with `subreddit_not_allowlisted`. This
   is the same allowlist the manual path has always enforced.
3. Set `REDDIT_AUTONOMOUS_PUBLISH=true`.
4. Verify with ONE post to a throwaway subreddit before widening the
   allowlist.

**What the autonomous path still does NOT have**, and what an operator is
therefore accepting when they enable it: no typed confirmation phrase, no
1/hour or 3/24h rate limit, and no 30-day duplicate fingerprint check. Those
live in `safe-test-policy`, which only the manual path consults. Bringing them
to the scheduler is a separate change and is not done here.
