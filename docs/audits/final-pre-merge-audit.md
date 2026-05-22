# Final pre-merge audit

Branch: `feature/weekly-approval-engine` → `main`
Date: 2026-05-22

This document captures the architecture findings, the cleanup that landed in this audit, the known limitations, and the merge-readiness verdict. It is the artifact that says: **this branch is ready to ship to `main` as Signal's first stable SaaS foundation**.

## Verdict

**Ready to merge.** Lint, typecheck, and build are green. Normal product mode shows no fabricated handles, no fake metrics, and no operational density that the user did not create. Demo mode is opt-in, clearly labeled, and isolated. Every engine the product depends on is deterministic and pure. The boundaries for the future integrations — AI runtime, OAuth, Supabase, regional routing — are written but not active.

## What was audited

20 audit slices, in order:

1. Global architecture — modules, types, engines.
2. Real vs demo boundary — routes, providers, hooks, stores, imports.
3. Route-by-route render audit (33 routes).
4. Empty-state system across every page that can be empty.
5. UI minimalism (cards, badges, density).
6. Language and positioning across UI copy + docs.
7. State management (providers, reducers, hooks, derivations).
8. Engine boundaries (scheduler, cadence, risk, approval, geo, discoverability, content/comment intelligence, memory, data-mode).
9. AI readiness architecture.
10. Geo & network operations layer.
11. Auth / OAuth readiness language.
12. Supabase planning coherence.
13. Mobile / responsive structure.
14. Performance / bundle shape.
15. Security / trust posture.
16. Documentation tree.
17. Final product direction.
18. QC (lint / typecheck / build).
19. This report.
20. Merge readiness.

## Findings and actions

### Real vs demo boundary — clean

- The `src/core/data-mode/` boundary is the single source of truth for "is this real or demo?". Modules: `data-mode.ts`, `real-empty-state.ts`, `use-data-mode.ts`, `demo-state.ts`, `data-source.ts`.
- `useDataMode()` returns the live mode + `hasProducts` / `hasAccounts` / `hasItems` / `hasBacklog` / `hasAnyOperationalData` / `shouldShowRealEmpty`.
- `useDemoData(arr)` returns `[]` in normal mode for every mock array imported by intelligence and platform pages.
- `signal-shell.tsx` seeds the store with empty arrays unless demo mode is on; a keyed remount cleanly reseeds when the mode flips.
- The demo banner + the per-page `DemoLabel` chip both render only when demo mode is active.
- Demo mode can be forced on at deploy time via `NEXT_PUBLIC_SIGNAL_DEMO_MODE` (true / 1 / yes). The settings toggle disables itself with an "(env-forced)" tag when forced.

**Verified leaks closed:**
- `/search` hint examples no longer mention "WebmasterID", "cashworkspace.com", "@webmasterid", or "u/wmi_observer".
- Every route in the audit list renders a clean empty state in normal mode.

### Route-by-route audit

| Route | Normal-mode state | Demo-mode state |
| --- | --- | --- |
| `/` | Marketing landing | n/a |
| `/dashboard` | `EmptyDashboard` (welcome + setup CTAs + OAuth note) | `NextBestActions`, `OnboardingChecklist`, cadence |
| `/accounts` | "No connected accounts yet" + Add account CTA | Account list |
| `/accounts/[id]` | `NotFound` (store has no accounts) | Full setup kit |
| `/accounts/new` | Wizard renders; uses `platforms` metadata only | Same |
| `/weekly-plan` | "No weekly plan yet" + CTAs | Plan list |
| `/approval-queue` | "No items awaiting approval" | Pending list |
| `/scheduler` | "Nothing scheduled yet" | Weekly grid |
| `/backlog` | "Backlog is empty" | Backlog list |
| `/platforms` | Per-platform "not connected" cards + Google "not connected" | Full metrics |
| `/platforms/{reddit,x,linkedin}` | `PlatformNotConnectedPanel` with OAuth future card | Full command center |
| `/platforms/google` | `NotConnectedState` (noDiscoverability) with explicit "no fake rankings" line | Full visibility surface |
| `/content-intelligence` | "No insights yet" + Add product CTA | Insights list |
| `/comments` | "No platform activity yet" + Add account CTA | Drafts |
| `/discussions` | "No platform activity yet" + Add account CTA | Discussion list |
| `/opportunities` | "No opportunities yet" + Add product / Add account CTAs | Opportunities |
| `/discoverability` | "Discoverability data not connected" + explicit honesty note | Opportunities |
| `/analytics` | "No analytics data yet" + reserved UTM params | Same (already honest) |
| `/risk-center` | `NotConnectedState` (noRiskItems) | 0/0/0/0 tiles + sections |
| `/activity` | `NotConnectedState` (noActivity) | Operational timeline |
| `/search` | Hints panel | Same with results |
| `/settings` | Workspace card + Demo toggle + Platform connections + AI provider | Same |
| `/settings/network` | Region/timezone/language form + consistency panel | Same |
| `/settings/ai-memory` | Mock memory inventory + retrieval preview (debug) | Same |
| `/workflow` | 12-stage architecture map (static educational) | Same |
| `/products`, `/products/[slug]` | Empty or "Add product" CTA | Product list |
| `/about`, `/how-it-works`, `/philosophy`, `/security` | Marketing pages | n/a |

All 33 routes render. No dead actions, no broken navigation.

### Empty-state system

Unified through `REAL_EMPTY_COPY` in `src/core/data-mode/data-mode.ts` and the `NotConnectedState` component. Eight canonical keys: `noConnectedAccounts`, `noWeeklyPlan`, `noOpportunities`, `noDiscoverability`, `noActivity`, `noInsights`, `noPlatformActivity`, `noRiskItems`. Every empty state follows the same pattern — title, one short explanation, one primary CTA, optional trust note. No fake stats, no empty charts, no synthetic placeholders.

### UI minimalism — done

The intelligence pages dropped their compute-on-empty paths in favor of a single empty card. The platforms overview replaced `0/0` mini-stats with a dashed "not connected" tile. The risk-center 0/0/0/0 grid is gone in empty mode. The dashboard hits `EmptyDashboard` immediately when state is empty and demo is off.

### Language and positioning — clean

Stealth / anti-detect sweep across `src/` and `docs/`: every match is a **negation** (e.g. "not anti-detect", "Signal does not use proxies", "no fingerprint randomization") or a **blocked-behavior token** in the safety policy. No occurrence positions Signal as a stealth tool. UI copy across all platform / network / AI surfaces uses the agreed vocabulary: operational, regional, discoverability, cadence, workflow, approval, trust, stability, consistency.

### State management — single source of truth

- One `SignalProvider` mounts the store via React Context + `useReducer`.
- `useSignal()`, `useAccounts()`, `useAccount(id)`, `useApprovalActions()`, `useAccountActions()`, `useDispatch()` are the only entry points.
- The seed is gated by `useDemoMode()`; a `key={demoMode ? "demo" : "real"}` remount keeps demo and real state from mixing.
- `useDataMode()` derives the high-level booleans from the store; it is the only branch point pages use to choose between "show empty" and "show computed".

### Engine audit — all isolated and pure

| Engine | Location | Status |
| --- | --- | --- |
| Scheduler | `src/core/scheduler/` | Pure; deterministic redistribution |
| Cadence | `src/core/scheduler/` + `src/core/operational-safety/` | Pure |
| Risk engine v1 | `src/core/risk/` | Pure 0–100 scoring |
| Approval engine | `src/core/approval/` | Pure state transitions |
| Geo engine | `src/core/geo/` | Pure; no rotation, no anti-detect |
| Discoverability | `src/core/discoverability/` | Pure |
| Content intelligence | `src/core/content-intelligence/` | Pure |
| Comment intelligence | `src/core/comment-intelligence/` | Pure |
| Memory layer | `src/core/memory/` | Pure; budget-capped; deterministic retrieval |
| Data-mode layer | `src/core/data-mode/` | Pure boundary; `RealDataSource` returns `[]` |
| Platforms | `src/core/platforms/` | Static strategy + computed readiness/load |
| Operational safety | `src/core/operational-safety/` | Pure helpers |
| Activity | `src/core/activity/` | Pure derivation from state |
| Search | `src/core/search/` | Pure |
| Onboarding | `src/core/onboarding/` | Pure setup-kit generation |
| Platform adapters | `src/core/platform-adapters/` | Pure adaptation |
| Demo mode | `src/core/demo-mode/` | Provider with `forcedByEnv` flag |

No engine performs I/O. No engine reads from `@/lib/mock` directly — only the shell seed does, and only when demo is on.

### AI readiness — coherent and minimal

The AI layer is wired end-to-end behind a typed `AiProvider` interface:

- `MockAiProvider` (deterministic, in-browser) is the live provider today.
- `OpenAiProviderPlaceholder` returns `provider_not_connected`.
- Ten allowed use cases, eleven blocked use cases.
- Token budgets per use case (2000 – 5000) enforced in `src/core/memory/token-budget.ts`.
- Retrieval is deterministic; same query + same snapshot returns the same items.
- Context assembly produces ordered layers (`system`, `workspace`, `platform`, `product`, `account`, `insight`, `risk`, `constraints`) with per-layer token counts.

No giant prompt scaffolding, no raw memory dumping, no autonomous loops. No `OPENAI_API_KEY` is read at runtime.

### Geo and network — operational, not stealth

- Workspace-level regional identity in `src/core/geo/region-policy.ts`. Nine regions with default timezone, language, and business-hour bounds.
- Three geo modes: `local_only`, `regional_operations`, `international_operations`.
- Region-consistency scoring is deterministic across six signals.
- Optional `NetworkProfile` (HTTP/HTTPS/SOCKS5) — workspace-level, no rotation, no pools, credentials masked client-side.
- `summarizeNetworkProfile()` strips credentials before they leave the server boundary.

No rotation, no anti-detect, no cookies, no fingerprints, no session systems.

### Auth / OAuth readiness — honest

- Eleven `CONNECTION_STATUSES` cover the full lifecycle.
- `ConnectionHealthRecord` carries refresh expiry, failure counter, degradation mode, recovery action.
- `MockConnectionProvider` returns every channel in `not_connected`; `startConnect` and `revoke` return `not_implemented` errors.
- UI clearly says "Connect via official OAuth" with disabled buttons everywhere.

No partial auth implementation. No fake tokens. No fake connected states.

### Supabase readiness — planned, not implemented

11 docs under `docs/database/`. Domain-model audit, entity classification, enums/statuses, RLS plan, OAuth token storage plan, indexing plan, retention plan, migration phases, mock-to-DB transition, schema plan, memory schema plan. No Supabase package is installed; no client code; no env variables.

### Mobile / responsive — solid

- `Sidebar` is `hidden lg:flex` (desktop only).
- `MobileNav` is `lg:hidden` (mobile only) and exposes five primary routes — Home, Plan, Approvals, Schedule, Risk.
- Pages use `max-w-*` containers and `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` patterns. No fixed pixel widths in critical layouts.

### Performance — within bounds

Build output (Next.js 14 App Router):

- 33 routes total. 30 statically prerendered, 2 dynamic (`/accounts/[id]`, `/products/[slug]`), one marketing landing.
- Largest route: `/platforms/google` at 8.73 kB. First-load JS shared by all: 87.2 kB.
- No oversized client component. No unnecessary state hydration. Demo-mode imports lazy-load when on.

### Security / trust — intact

- No password storage anywhere.
- No cookies, session tokens, 2FA codes, recovery codes referenced as storable values.
- No client-side secret exposure. The settings/network form has `autoComplete="new-password"` and an explicit "encrypted server-side" note.
- `CONNECTION_POLICY.neverAsk` and `AI_SAFETY_BLOCKED_OUTPUTS` codify the trust posture in code.

### Documentation — 74 markdown files

Tree under `docs/`: `ai/`, `architecture/`, `comment-intelligence/`, `content-intelligence/`, `database/`, `discoverability/`, `geo/`, `platforms/`, `product/`, `risk-engine/`, `safety/`. README updated at each phase. No `// TODO` markers in code. No "removed" placeholder files.

## Cleanup that landed in this audit

- Removed dead `emptyWorkspace` constant and its `void emptyWorkspace;` suppression from `src/components/signal-shell.tsx`.
- Removed unused `workspace as mockWorkspace` import from the same file.
- This audit doc (`docs/audits/final-pre-merge-audit.md`).

No behavioral changes. No feature removal. No API breakage.

## Known limitations (acknowledged, not blocking)

1. **Persistence not connected.** Supabase is documented in detail but not installed. All data lives in the React store and resets on reload.
2. **AI not connected at runtime.** `OpenAiProviderPlaceholder` returns `provider_not_connected`. No outbound HTTP.
3. **OAuth not connected.** `MockConnectionProvider` returns `not_connected` for every platform.
4. **WebmasterID analytics not connected.** Every analytics surface says "Data not yet connected".
5. **Stripe / billing not present.** Pricing is documented in the marketing surface but no billing layer exists.
6. **No background jobs.** Cadence redistribution runs on demand, not on a schedule.

These are intentional. The architecture is ready to receive each one without a rewrite.

## Next-phase recommendations

In rough priority order:

1. **Ship the marketing landing copy.** The `/` page references the product positioning; the public surfaces are stable.
2. **Wire Supabase persistence.** Start with the `accounts` and `products` tables; the schema is documented.
3. **Wire one platform OAuth flow end to end** as a reference implementation (likely LinkedIn given its OAuth ergonomics).
4. **Wire the AI route handler.** Replace `OpenAiProviderPlaceholder.generate()` with a server-side fetch; the contracts stay unchanged.
5. **Wire Search Console for `/platforms/google`.** Replace the "Data not yet connected" copy when real data lands; keep the `NotConnectedState` path for new workspaces.
6. **Add a billing layer** when the first user is ready to pay.

Each step is a contained change because the boundary already exists.

## Merge readiness checklist

- [x] `npm run lint` — clean.
- [x] `npm run typecheck` — clean.
- [x] `npm run build` — clean (33 routes).
- [x] Normal mode shows no fabricated handles, no fake metrics.
- [x] Demo mode labels every page that renders demo content.
- [x] No mock imports outside the shell seed bypass the boundary.
- [x] No stealth / anti-detect / growth-hack positioning in copy or docs.
- [x] No partial auth, OAuth, AI runtime, or Supabase implementation.
- [x] Mobile navigation works; sidebar adapts.
- [x] Documentation reflects the current product state.
- [x] Engines remain pure and deterministic.
- [x] No dead code blocks introduced; small dead-code items removed.

**Verdict: ready to merge `feature/weekly-approval-engine` → `main`.**
