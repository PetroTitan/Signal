# Mobile information architecture

Status: current as of the `feat/mobile-navigation-settings-parity` milestone.
Baseline audited: `origin/main` @ `861fb05`.

The reported symptom was "on mobile the operator cannot find MCP settings."
The cause was broader: mobile had no secondary navigation at all.

---

## 1. Why MCP was unreachable

Two independent gaps, either of which alone was enough.

**`/settings/mcp` had exactly one navigational entry in the entire
application** — `src/components/sidebar.tsx:64`. That entry lives inside
`<aside className="hidden lg:flex …">`, so it does not exist below 1024px,
and inside the "Advanced" group, which is collapsed by default even on
desktop.

**`/settings` did not link to MCP.** The settings index linked to five
sub-routes — setup, publishing-platforms, ai-memory, network, team — and
omitted MCP entirely. So reaching `/settings` on a phone would not have
helped either.

Underneath both: `topbar.tsx` renders a title, a description and an actions
slot, and nothing else. The five-item bottom bar was mobile's *only*
navigation. Ten desktop destinations had no mobile path, and sign-out —
which lived only in the sidebar footer — had none either.

Nothing failed, because nothing compared the navigation surfaces to the route
tree.

## 2. Navigation model

**Primary — the bottom bar, five destinations, unchanged.**

| | |
|---|---|
| Home | `/dashboard` |
| Plan | `/weekly-plan` |
| Publishing | `/execution` |
| Accounts | `/accounts` |
| Products | `/products` |

Plus a sixth control, **More**, which is not a destination — it opens the
secondary sheet.

Six controls give ~53px each at 320px, measured. A sixth *destination* was
rejected: there are eighteen secondary routes and the bar is not where that
grows. The Topbar was rejected too — there is no avatar or profile menu to
improve, and the top-right corner is the least one-handed part of a phone.
The bottom bar is already pinned, safe-area aware, and where a thumb rests.

**Secondary — the More sheet**, grouped as the sidebar already groups:

```
Publish              Content library · Results · Notifications ·
                     Backlog · Publishing scope · Activity
Workspace & settings Settings · Setup guide · Publishing platforms ·
                     MCP & AI integrations · Operator tokens ·
                     Team & access · AI memory · Region & network
Advanced             Operator bridge
                     ── Sign out
```

**Settings hub** — `/settings` now derives its directory from the manifest,
so a settings route cannot be added and silently left off it.

## 3. The manifest

`src/core/navigation/route-manifest.ts` lists all 28 authenticated routes
exactly once with a tier. Every nav surface derives from it: the mobile bar,
the More sheet, the settings hub. The desktop sidebar keeps its hand-authored
order and icons — that arrangement is deliberate and rewriting it would be
churn — but it can no longer be a route's *only* home.

| Tier | Meaning | Count |
|---|---|---|
| primary | bottom bar + sidebar | 5 |
| secondary | More sheet + sidebar | 6 |
| settings | Settings hub + More + sidebar | 8 |
| internal | deliberate, reached on purpose | 1 |
| contextual | reached from a list or card | 5 |
| orphaned | nothing links here — a finding | 3 |

## 4. Role-aware visibility

Role is already on the client session (`useMaybeWorkspaceSession().role`) and
`can()` is a pure predicate, so this needed no new plumbing.

Gated on `manage_settings`: MCP, operator tokens, region & network, operator
bridge. Gated on `manage_members`: team & access. Gated on
`connect_platforms`: publishing platforms.

**Hidden navigation is not security.** These rules decide what is worth
showing. Every one of those pages enforces its own access server-side, and
this milestone changed none of that enforcement.

## 5. Orphaned routes — a finding, not a design

Three routes have no live inbound link anywhere:

| Route | Evidence |
|---|---|
| `/accounts/new` | Only linkers are `command-center.tsx` (rendered nowhere) and `core/data-mode` (reached only from it). `/accounts` embeds `AccountCreateForm` inline. |
| `/accounts/[id]` | `/accounts` manages identities inline via `IdentityCardWithManage`; the only live linker is `/accounts/new`, itself orphaned. |
| `/products/[slug]` | Only linker is `core/search`, which has no consumers. |

All three are `"use client"` pages reading the **demo store** rather than the
repositories. Linking them would not show real data — an attempt to link
product cards to `/products/[slug]` was reverted on discovering the products
table has no slug column, so every real product would have rendered "Product
not found".

They are left in place. Deleting a route is a product decision about the
demo-store pages, not a navigation fix. They are recorded so they are visible.

## 6. The guard

`src/test/route-manifest.test.ts` walks the App Router tree and fails when a
page has no manifest entry, or an entry has no page.

It also **verifies** reachability rather than accepting the manifest's word
for it: a contextual route must have a real inbound link in the source, an
orphaned route must not. Reachability is transitive — a link from an orphaned
page does not count, or an unreachable cluster vouches for itself. Three link
sources are excluded as non-navigational, each with its evidence: two dead
components, and `core/activity/derive.ts`, whose `link:` field no renderer
reads.

The first version of this guard only checked that a `reachableFrom` string
was non-empty. It passed while three of those strings were false. A claim in
a comment is not evidence.

## 7. Known limitations

- The desktop sidebar still keeps its own ordered array. The coverage test
  prevents a route being sidebar-only, but the sidebar's *order and icons*
  remain hand-authored by design.
- `/settings` remains a `"use client"` page reading the demo store for its
  connection and product counts; only its directory section is manifest-driven.
- The three orphaned routes are recorded, not resolved.
- Responsive QA is headless-Chromium viewport emulation, not real devices.
