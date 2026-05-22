# Signal

Founder growth infrastructure. Calm, operational, OAuth-first.

Signal is an AI-assisted growth operations platform for founders and SaaS teams. It treats organic presence as an operational problem — one that benefits from calm cadence, clean approval, and platform-native participation, not from posting volume.

Public surfaces: [/about](src/app/(marketing)/about/page.tsx), [/philosophy](src/app/(marketing)/philosophy/page.tsx), [/how-it-works](src/app/(marketing)/how-it-works/page.tsx), [/security](src/app/(marketing)/security/page.tsx).

## Product philosophy

Signal does not maximize posting volume. It maximizes sustainable organic presence.

The founder reviews one weekly plan. Signal handles the cadence, the spacing, the tone constraints, and the platform-specific rhythm. Activity stays consistent. The founder stays focused on building.

## What Signal helps you do

- Maintain consistent platform-native presence.
- Avoid impulsive overposting.
- Reduce platform-risk behavior.
- Prepare a single weekly growth plan.
- Approve once per week.
- Distribute activity organically across the week.

## What Signal is not

Signal is not a spam bot. It is not an anti-detect browser, an account farm manager, a proxy or fingerprint system, a mass automation tool, or a password manager.

## What Signal is

- Weekly growth planning.
- Approval workflows.
- Scheduling intelligence.
- Risk and cadence control.
- Platform-native adaptation.
- WebmasterID-ready analytics infrastructure.

## Initial target platforms

Reddit, X, LinkedIn.

## Architecture overview

- Next.js with the App Router.
- TypeScript, strict.
- Tailwind CSS.
- Supabase for auth + workspace / product / account / settings / activity persistence (Phase C).
- No Stripe, no real AI APIs, no platform OAuth integrations yet.
- Engine-driven surfaces (weekly plan, scheduler, risk center) continue to render from the in-memory React store; their persistence migration is a later phase.

See [docs/architecture/mvp-architecture.md](docs/architecture/mvp-architecture.md) for the source layout and conventions.

## Supabase + auth foundation

Phase C adds the stateful SaaS foundation:

- Email + password auth via `/login`, `/signup`, and a server-action sign-out. `src/middleware.ts` refreshes sessions and gates protected routes.
- Repository layer in `src/repositories/` for workspaces, products, accounts, settings, and activity. UI components never touch Supabase directly.
- Migrations under `supabase/migrations/` create the six Phase C tables with RLS policies and two `is_workspace_member` / `is_workspace_owner` helpers. No service-role-key dependency anywhere.
- A default `Signal Workspace` is created on signup (or on first authenticated visit if signup runs the email-confirmation flow).
- `/products` and `/accounts` are now DB-backed server components with inline create forms. `/activity` lists real workspace events.
- Settings page persists `region`, `timezone`, and `language` to the database.
- Demo mode (`NEXT_PUBLIC_SIGNAL_DEMO_MODE`) continues to work for engine-driven surfaces — clearly labeled with a `Demo preview` chip on every page.

See [docs/database/supabase-auth-foundation.md](docs/database/supabase-auth-foundation.md), [docs/database/phase-c-migrations.md](docs/database/phase-c-migrations.md), [docs/database/repository-layer.md](docs/database/repository-layer.md), [docs/database/real-empty-state.md](docs/database/real-empty-state.md), [docs/auth/email-password-auth.md](docs/auth/email-password-auth.md), and [docs/security/rls-phase-c.md](docs/security/rls-phase-c.md).

## Persistence expansion (Phase D)

Phase D moves the weekly operations into Supabase:

- Seven new tables: `weekly_plans`, `weekly_plan_items`, `approval_events`, `backlog_items`, `scheduled_items`, `risk_events`, `draft_variants`. Each is RLS-protected and workspace-scoped, reusing the `is_workspace_member` / `is_workspace_owner` helpers from Phase C.
- Six new repositories under `src/repositories/`: weekly-plan, approval, backlog, scheduled-item, risk-event, draft-variant.
- `/weekly-plan`, `/approval-queue`, and `/backlog` are now DB-backed server components. Each has an honest empty state and inline server-action forms.
- Approvals are append-only: every approve / reject / send-to-backlog / restore writes an `approval_events` row plus an `activity_events` row.
- `/scheduler`, `/risk-center`, and `/dashboard` still render from the in-memory React store — their persistence migration is a later phase. The DB tables already exist so it slots in without another migration.

Apply Phase C + Phase D migrations with:

```
supabase db push
```

Both must be applied in order. The Phase D RLS migration depends on Phase C's helpers.

AI runtime, platform OAuth, publishing, Stripe, background jobs, and WebmasterID analytics ingestion remain **not implemented**.

See [docs/database/phase-d-persistence-expansion.md](docs/database/phase-d-persistence-expansion.md), [docs/database/phase-d-migrations.md](docs/database/phase-d-migrations.md), [docs/database/weekly-plan-persistence.md](docs/database/weekly-plan-persistence.md), [docs/database/approval-backlog-scheduler-persistence.md](docs/database/approval-backlog-scheduler-persistence.md), [docs/database/risk-draft-persistence.md](docs/database/risk-draft-persistence.md), and [docs/database/activity-events-phase-d.md](docs/database/activity-events-phase-d.md).

### Environment

Copy `.env.example` to `.env.local` and fill in:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_SIGNAL_DEMO_MODE=false
```

`NEXT_PUBLIC_SIGNAL_DEMO_MODE=true` force-enables demo mode for sandbox deploys; the settings toggle becomes a no-op in that case.

## Mock data is intentionally minimal

Signal's seed data is small on purpose. The product is designed to render gracefully with 1–2 items per surface — density is not a feature, and fake scale is avoided everywhere:

- No invented engagement numbers, impression counts, or revenue claims.
- No synthetic handles. Accounts that don't exist on a platform stay in `planned` status with `handle: null` and "No connected account yet."
- When data isn't available, the UI says "Data not yet connected."
- Real persistence arrives later through the phased Supabase plan in [docs/database/](docs/database/).

Normal product mode shows only data the user created, connected, imported, or approved. Demo data is gated behind explicit demo mode and every page that displays it renders a `Demo preview — This data is not connected to real accounts` label. The boundary lives in [src/core/data-mode/](src/core/data-mode/); pages branch on `useDataMode()` and render the canonical `NotConnectedState` instead of computing fake `0/0` cards.

See [docs/product/pre-final-cleanup.md](docs/product/pre-final-cleanup.md), [docs/product/demo-data-policy.md](docs/product/demo-data-policy.md), and [docs/product/ui-realism-guidelines.md](docs/product/ui-realism-guidelines.md).

## Database planning status

Supabase is planned but **not integrated yet**. The schema is documented in detail before any migration is written.

- The local mock architecture under `src/lib/mock` remains the data source.
- No Supabase package is installed; no client code, no migrations, no env variables.
- Future implementation is phased (A → core, B → onboarding, C → intelligence, D → discoverability, E → analytics, F → OAuth, F+ → SaaS).
- Signal does not store passwords, cookies, session tokens, 2FA codes, or recovery codes. There are no columns for any of these. The OAuth-first model is structural.

Schema plan and supporting docs:

- [docs/database/domain-model-audit.md](docs/database/domain-model-audit.md)
- [docs/database/entity-classification.md](docs/database/entity-classification.md)
- [docs/database/supabase-schema-plan.md](docs/database/supabase-schema-plan.md)
- [docs/database/stored-vs-computed.md](docs/database/stored-vs-computed.md)
- [docs/database/enums-and-statuses.md](docs/database/enums-and-statuses.md)
- [docs/database/rls-security-plan.md](docs/database/rls-security-plan.md)
- [docs/database/oauth-token-storage-plan.md](docs/database/oauth-token-storage-plan.md)
- [docs/database/migration-phases.md](docs/database/migration-phases.md)
- [docs/database/mock-to-db-transition.md](docs/database/mock-to-db-transition.md)
- [docs/database/indexing-performance-plan.md](docs/database/indexing-performance-plan.md)
- [docs/database/data-retention-audit-plan.md](docs/database/data-retention-audit-plan.md)

## Operations command center, activity, search, workflow

The [/dashboard](src/app/(app)/dashboard/page.tsx) leads with four operational panels — `NextBestActions`, `SystemHealth`, `WhatChangedThisWeek`, and `ItemsNeedingJudgment` — so the founder lands on actionable judgment surfaces.

- [/activity](src/app/(app)/activity/page.tsx) — internal operational timeline derived from live state. Filterable by layer and severity. No fake analytics.
- [/search](src/app/(app)/search/page.tsx) — deterministic search across products, accounts, items, backlog, insights, content assets, risk signals, and docs. Topbar carries a search affordance from every route.
- [/workflow](src/app/(app)/workflow/page.tsx) — Signal's twelve-stage operating loop, useful for onboarding and architecture review.

An explainability layer (`Explain` + eight `Why*` wrappers in `src/components/explain.tsx`) gives every engine a calm, consistent way to surface "why this happened" inline.

A pre-Supabase state-readiness audit captures which entities are stable, which are derived, and what the eventual table boundaries should look like.

See [docs/architecture/operational-stabilization.md](docs/architecture/operational-stabilization.md), [docs/architecture/explainability-layer.md](docs/architecture/explainability-layer.md), [docs/architecture/state-readiness-audit.md](docs/architecture/state-readiness-audit.md), [docs/product/global-activity-timeline.md](docs/product/global-activity-timeline.md), [docs/product/internal-search.md](docs/product/internal-search.md), and [docs/product/workflow-map.md](docs/product/workflow-map.md).

## Weekly approval concept

Signal compresses every growth decision into a single weekly checkpoint:

1. Signal assembles a weekly plan from product profiles, account states, and platform cadence.
2. You review the plan once, in the approval queue.
3. Approved items distribute across the week with cooldown and cadence awareness.
4. The risk center flags drift from product tone and platform rhythm.
5. Items that exceed safe capacity move to the backlog instead of being fired anyway.

No daily notifications. No urgency. One review.

See [docs/product/weekly-approval-workflow.md](docs/product/weekly-approval-workflow.md).

## The engines

Signal's operational heart is three pure TypeScript modules in `src/core/`:

- **Scheduler** ([docs/architecture/scheduler.md](docs/architecture/scheduler.md)) — slot generation, account cooldown, platform cadence, and a redistribution algorithm that places items in promotional-weight order so educational content gets the prime slots and link-bearing posts get the safer ones.
- **Risk engine v1** ([docs/risk-engine/risk-scoring-v1.md](docs/risk-engine/risk-scoring-v1.md)) — deterministic 0–100 scoring with a level (low / medium / high / blocked), reasons, and a calm recommendation. No model calls, no randomness.
- **Approval engine** — pure state transitions for every approval-queue action, plus a plan summarizer for the weekly overview.

All three are consumed by a small React Context + useReducer store. Every mutation rescores the entire plan and re-derives plan status.

## Platform command centers

Four platform-native lenses over the same shared core. Three are social — Reddit, X, LinkedIn — and one is search-only — Google. The overview at [/platforms](src/app/(app)/platforms/page.tsx) compares them; each command center has its own strategy, accounts (where applicable), queue, risk or opportunity surface, a 10-module playbook, and an OAuth-not-yet-enabled card. Signal does not become a generic universal dashboard — each surface is treated on its own terms.

See [docs/architecture/one-core-platform-command-centers.md](docs/architecture/one-core-platform-command-centers.md), [docs/platforms/command-centers.md](docs/platforms/command-centers.md), [docs/platforms/reddit-command-center.md](docs/platforms/reddit-command-center.md), [docs/platforms/x-command-center.md](docs/platforms/x-command-center.md), [docs/platforms/linkedin-command-center.md](docs/platforms/linkedin-command-center.md), and [docs/platforms/google-visibility-command-center.md](docs/platforms/google-visibility-command-center.md).

## Content intelligence

Signal is insight-first, not output-first. A small library of `SourceInsight` rows — founder observations, product lessons, support patterns, industry patterns — drives every suggestion. The content intelligence engine produces platform-native opportunities, draft variants, and a content-memory summary; the comment intelligence engine produces discussion opportunities (with explicit participate / watch / **skip** recommendations) and calm comment and reply drafts gated by a conversation risk layer. No external AI API, no auto-publishing, no fake engagement.

Routes: [/content-intelligence](src/app/(app)/content-intelligence/page.tsx), [/opportunities](src/app/(app)/opportunities/page.tsx), [/discussions](src/app/(app)/discussions/page.tsx), [/comments](src/app/(app)/comments/page.tsx).

See [docs/architecture/content-intelligence-architecture.md](docs/architecture/content-intelligence-architecture.md), [docs/content-intelligence/source-insights.md](docs/content-intelligence/source-insights.md), [docs/content-intelligence/platform-adapters.md](docs/content-intelligence/platform-adapters.md), [docs/content-intelligence/content-memory.md](docs/content-intelligence/content-memory.md), [docs/comment-intelligence/comment-engine.md](docs/comment-intelligence/comment-engine.md), and [docs/comment-intelligence/conversation-risk-layer.md](docs/comment-intelligence/conversation-risk-layer.md).

## Search & discoverability operations

Google is treated as a search & discoverability surface, not a publishing one. [/platforms/google](src/app/(app)/platforms/google/page.tsx) hosts visibility, content freshness, topical coverage, internal linking, evergreen content, under-promoted content, and YouTube planning. A top-level [/discoverability](src/app/(app)/discoverability/page.tsx) dashboard adds the cross-channel lens: search-to-social, social-to-search, topic cluster gaps, and refresh windows. No Search Console API, no YouTube API, no indexing API, no automated publishing.

See [docs/discoverability/search-discoverability-operations.md](docs/discoverability/search-discoverability-operations.md).

## Backlog and cadence protection

The [/backlog](src/app/(app)/backlog/page.tsx) page holds items Signal would not publish this week — saved by the founder, deferred because cadence is full, or blocked because the account is still in setup. Restoring an item runs the scheduler again and rescores the week.

Cadence protection messages surface on the dashboard, the approval queue, and the scheduler. They are calm and concrete: *"You already scheduled enough X content this week. Signal will hold further items in the backlog."*

See [docs/product/backlog-system.md](docs/product/backlog-system.md) and [docs/product/cadence-protection.md](docs/product/cadence-protection.md).

## Account setup assistant

The accounts page hosts a four-step wizard at [/accounts/new](src/app/(app)/accounts/new/page.tsx): pick a platform, pick a product, pick a role, generate a setup kit. The kit covers usernames, display names, three bios, an about/profile block, avatar and cover briefs, ten content ideas, ten comment ideas, a 14-day warm-up plan, and a manual setup checklist with eight stable steps.

The detail page renders the full kit and exposes click-to-toggle checklist items, status actions (move to warming/active, mark ready for planning, pause/resume), and a "refresh setup kit" action that regenerates the kit while preserving progress.

See [docs/product/account-onboarding.md](docs/product/account-onboarding.md), [docs/product/account-readiness-scoring.md](docs/product/account-readiness-scoring.md), and [docs/product/account-warm-up-workflow.md](docs/product/account-warm-up-workflow.md).

## OAuth-first account model

Every account in Signal will connect through the platform's official authorization flow. Signal will never ask for passwords, cookies, session tokens, 2FA codes, or recovery codes. Until OAuth providers are wired in, the accounts page exposes the model and the disabled connect controls.

See [docs/platforms/oauth-first-principle.md](docs/platforms/oauth-first-principle.md) and [docs/platforms/platform-adapters.md](docs/platforms/platform-adapters.md).

## AI integration readiness

Signal ships in **local preview mode**. The AI architecture is wired end-to-end behind a typed provider interface so that switching to a real model later is a small, contained change:

- `AiProvider` interface with typed `generate<U>(useCase, input)` and discriminated structured outputs.
- `MockAiProvider` (deterministic, in-browser) used by today's UI and tests.
- `OpenAiProviderPlaceholder` that returns `provider_not_connected` until the server-side route handler ships.
- Ten allowed use cases (`ALLOWED_AI_USE_CASES`) and eleven explicitly blocked use cases — no autonomous agents, no auto-publishing, no fake metrics.
- Cost policy: no AI on render, human-triggered only, max 3 variants per request.
- Safety policy: blocked outputs are filtered before any model would be called.

No `OPENAI_API_KEY` is read at runtime. No outbound HTTP calls are made. The settings page exposes the active provider, its connection status, and the allowed use cases.

See [docs/ai/ai-integration-readiness.md](docs/ai/ai-integration-readiness.md), [docs/ai/prompt-contracts.md](docs/ai/prompt-contracts.md), [docs/ai/cost-policy.md](docs/ai/cost-policy.md), and [docs/ai/safety-policy.md](docs/ai/safety-policy.md).

## Account authentication readiness

Platform connections live behind the same provider pattern. `ConnectionProvider` is the interface; `MockConnectionProvider` returns every channel in `not_connected` state today. When OAuth is enabled, the real implementation slots in behind the same contract — the settings UI does not change.

- Seven connection statuses (`not_connected`, `pending_authorization`, `connected`, `expired`, `revoked`, `error`, `unsupported`).
- Per-platform capability profiles distinguishing social participation from search discoverability.
- Planned OAuth scopes per platform, with publishing scopes marked explicitly.
- A `CONNECTION_POLICY` `neverAsk` list that encodes Signal's trust posture in code: no passwords, cookies, session tokens, 2FA codes, recovery codes, browser fingerprints, or proxy configuration.
- The settings page lists each channel with its status, capability summary, and a disabled "Connect via official OAuth" button.

See [docs/platforms/account-authentication-readiness.md](docs/platforms/account-authentication-readiness.md) and [docs/platforms/platform-capability-matrix.md](docs/platforms/platform-capability-matrix.md).

## AI memory and context pipeline

Signal does not send giant prompts. Memory is structured, compressed, and retrieved per task:

- Eight typed entity kinds in `src/types/memory/`: `WorkspaceMemory`, `PlatformMemory`, `ProductMemory`, `AccountMemory`, `HistoricalPattern`, `RiskMemory`, `AiPreference`, `BlockedPhrase`. Every entity carries `schemaVersion`, `lastUpdatedAt`, and `active` so schemas can evolve without losing history.
- `MockMemoryRetriever` ranks and caps memory by task token budget before any context reaches a model. Same query + same snapshot = same items, deterministic.
- `assembleContext()` flattens ranked memory into ordered layers (`system`, `workspace`, `platform`, `product`, `account`, `insight`, `risk`, `constraints`) with per-layer token counts.
- `TOKEN_BUDGETS` caps every use case: 2k for short rewrites, 3k for adaptations, up to 5k for draft variants. No use case can grow its budget at runtime.
- `compressEventsToPatterns()` collapses raw events into compact `HistoricalPattern` rows with confidence + support count. Patterns are recomputed, never appended unbounded.
- The pipeline is: retrieve → rank → compress → assemble → validate budget → provider → structured output → risk review → human approval. No autonomous loop wraps it.

A debug surface at [/settings/ai-memory](src/app/(app)/settings/ai-memory/page.tsx) shows active entities, estimated token sizes, the retrieved ranking, and the assembled context layers for any allowed use case.

See [docs/ai/memory-architecture.md](docs/ai/memory-architecture.md), [docs/ai/context-pipeline.md](docs/ai/context-pipeline.md), [docs/ai/token-budgets.md](docs/ai/token-budgets.md), and [docs/database/memory-schema-plan.md](docs/database/memory-schema-plan.md).

## Regional operations

Signal supports workspace-level regional routing: one stable operational region per workspace, with calm regional publishing windows, deterministic region-consistency scoring, and an optional outbound network profile for businesses that operate from a different network than the device running Signal.

- Nine supported regions in `src/core/geo/region-policy.ts` (US East/Central/West, EU West/Central, UK, Japan, APAC, Global) with default timezone, language, business-hour bounds, and cadence profile.
- Three geo modes: `local_only`, `regional_operations`, `international_operations`.
- Default publishing windows per region in `src/core/geo/timezone-routing.ts` — morning + evening for US, morning + afternoon for EU/UK/JP/APAC, UTC working hours for global.
- Subtle regional cadence hints in `src/core/geo/regional-cadence.ts` (tone / pacing / discoverability) feed into the platform-adaptation contract without faking localization.
- `scoreRegionConsistency()` produces a deterministic 0–1 score across six signals (timezone alignment, publishing window consistency, region stability, routing stability, cadence consistency, language alignment).
- Optional `NetworkProfile` carries label, region, protocol (HTTP/HTTPS/SOCKS5), host, port, masked credentials. The browser never sees plaintext; credentials are encrypted server-side. No rotation, no pools, no marketplace.
- Settings UI at [/settings/network](src/app/(app)/settings/network/page.tsx) — calm, mobile-friendly, enterprise-clean. Configure once.

This is operational infrastructure, **not** anti-detect tooling, stealth automation, fingerprint spoofing, browser masking, cookie/session management, proxy farming, or rotation. Regional routing never bypasses approval, cadence, or risk checks.

See [docs/geo/workspace-region-architecture.md](docs/geo/workspace-region-architecture.md), [docs/geo/regional-routing.md](docs/geo/regional-routing.md), [docs/geo/network-profile-system.md](docs/geo/network-profile-system.md), [docs/safety/region-consistency.md](docs/safety/region-consistency.md), and [docs/platforms/geo-aware-operations.md](docs/platforms/geo-aware-operations.md).

## Long-lived connections and one-time setup

Signal is designed to feel like durable infrastructure. Configure once, reuse context safely, recover gracefully:

- Connection statuses expanded to cover the long-lived lifecycle: `not_connected`, `ready_to_connect`, `pending_authorization`, `connected`, `healthy`, `degraded`, `expired`, `revoked`, `reauthorization_required`, `disabled`, `error`. Helpers (`isHealthy`, `needsUserAction`, `publishingAllowed`) classify them.
- Every connection carries a typed `ConnectionHealthRecord` with refresh expiry, failure counter, recovery action, and degradation mode. `deriveConnectionState()` derives the live triple from explicit lifecycle states and the health record.
- Three consecutive failed syncs drop the connection to `draft_only` mode. Drafts and schedules are preserved. Signal never retries aggressively.
- Memory and connection schemas carry `schemaVersion` so they can evolve in place without losing history or invalidating past approved drafts.
- UI copy is realistic — "configure once," "may occasionally require reauthorization," "falls back to draft-only mode" — never "works forever" or "no bugs."

See [docs/architecture/one-time-setup-principle.md](docs/architecture/one-time-setup-principle.md) and [docs/platforms/long-lived-connections.md](docs/platforms/long-lived-connections.md).

## Operational safety layer

Account health is encoded as constants and pure helpers in `src/core/operational-safety/`:

- `ACCOUNT_HEALTH_POLICY` — warm-up window, max direct-link ratio, high-velocity threshold, suggested quiet days.
- `recommendCadenceDelay()` and `calculateAccountCalmScore()` — cadence safety.
- `shouldSuppressLink()` — per-platform link tolerance.
- `detectCrossPlatformSimilarity()` — Jaccard token similarity across platforms to catch drift.
- `shouldRecommendSilence()` and `countQuietDays()` — calm-period recommendations.

These helpers are deterministic and do not call any model. They are the substrate the AI and platform layers compose against.

See [docs/safety/account-health-first.md](docs/safety/account-health-first.md), [docs/safety/operational-safety-layer.md](docs/safety/operational-safety-layer.md), and [docs/architecture/ai-and-auth-boundaries.md](docs/architecture/ai-and-auth-boundaries.md).

## MCP Operations Console

`/settings/mcp` is Signal's operator-facing surface for the AI / MCP layer. It shows:

- declared status of connected assistants (Claude Code, Codex, Claude Opus) and tools (Supabase MCP, GitHub MCP, Vercel)
- a read-only check runner — only checks with a real implementation are clickable; the rest render disabled with **"Prepared, not connected"**
- pending MCP approvals with explicit Approve / Reject buttons
- recent `mcp_operation_runs` history
- the safety boundary (allowed-without-approval, requires-approval, always-blocked)

Connection status is intentionally limited to a self-declared vocabulary (`not_configured | configured | connected | unavailable | manual | placeholder`). Real connection detection is not implemented yet — until it is, the page says **"placeholder"** and never claims "Connected."

Every production-impacting operation requires approval. Migration apply and similar operations require an explicit text confirmation phrase. See [docs/mcp/mcp-connector-ui.md](docs/mcp/mcp-connector-ui.md), [docs/mcp/check-runner.md](docs/mcp/check-runner.md), and [docs/mcp/operation-approval-ui.md](docs/mcp/operation-approval-ui.md).

The companion `/imports` surface is the assisted-import landing page. The extraction engine itself runs through Claude Code / Codex / Claude Opus and is not yet wired in this build — the page says so explicitly.

## Platform OAuth connections

`/accounts` connects social accounts only through official OAuth flows. Signal **never** asks for passwords, cookies, session tokens, 2FA codes, recovery codes, browser profiles, or fingerprints.

Phase E3 ships the connection foundation:

- `platform_connections` (workspace-scoped, RLS) and `oauth_state_tokens` (CSRF binding).
- A pure `src/core/platform-oauth/` module: provider configs for Reddit, X, and LinkedIn; PKCE helpers; state generation; capability matrix; connection-health evaluator.
- Four API routes per platform: `/api/oauth/[platform]/{start,callback,disconnect,health}`.
- UI on `/accounts` (Connect / Disconnect / Check connection) and `/platforms/{reddit,x,linkedin}` (read-only OAuth contract panel).

Phase E3 does **not** publish posts, comments, or engagement signals. No write scopes are requested. There are no background jobs and no automatic token refresh.

**Token storage policy** ([docs/oauth/token-storage-policy.md](docs/oauth/token-storage-policy.md)): tokens are stored encrypted or not at all. If `TOKEN_ENCRYPTION_KEY` is unset, the OAuth callback completes but the connection is recorded with `connection_status='error'` and `metadata.token_storage='not_configured'` — no plaintext is ever stored. The UI shows whether a token is present (a boolean), never the value.

See [docs/oauth/platform-oauth-connections.md](docs/oauth/platform-oauth-connections.md), [docs/oauth/reddit-oauth.md](docs/oauth/reddit-oauth.md), [docs/oauth/x-oauth.md](docs/oauth/x-oauth.md), [docs/oauth/linkedin-oauth.md](docs/oauth/linkedin-oauth.md), [docs/oauth/connection-health.md](docs/oauth/connection-health.md), and [docs/oauth/oauth-env-setup.md](docs/oauth/oauth-env-setup.md).

## Execution engine

`/execution` is the durable runner for an approved weekly contract. Phase E2 ships the engine in **dry-run only** mode — no external platform APIs are called, no publishing happens. The runner evaluates each item against the active contract, records the verdict to `execution_authorizations`, walks the state machine, and writes the result to `execution_logs` and `execution_attempts`.

Hard guarantees:

- no active contract → no execution
- no `allowed` authorization → no execution
- no confirmed plan item → no execution
- no external platform calls
- no silent failures — every attempt writes an `execution_attempts` row
- every denial logs the reason code

The four tables (`execution_queues`, `execution_items`, `execution_logs`, `execution_attempts`) are workspace-scoped, RLS-protected, and append-only where it matters (logs are read+insert only; attempts allow updates but not deletes). The state machines for queues and items live in `src/core/execution-engine/execution-state-machine.ts` and return typed transition verdicts instead of throwing.

See [docs/execution/execution-engine.md](docs/execution/execution-engine.md), [docs/execution/dry-run-mode.md](docs/execution/dry-run-mode.md), [docs/execution/execution-state-machine.md](docs/execution/execution-state-machine.md), [docs/execution/contract-authorization.md](docs/execution/contract-authorization.md), [docs/execution/queue-and-items.md](docs/execution/queue-and-items.md), [docs/execution/retry-policy.md](docs/execution/retry-policy.md), and [docs/execution/execution-logs.md](docs/execution/execution-logs.md).

## Weekly operating contract

Signal's core operational model is "the user approves once per week, and Signal may then operate for 7 days within explicitly approved boundaries." `/weekly-contracts` is the surface for drafting, approving (with a confirmation phrase), activating, pausing, and revoking those envelopes. The contract scopes execution to specific accounts, products, platforms, allowed action types, risk ceiling, cadence ceilings, and execution windows.

The evaluator at `src/core/weekly-contract/contract-evaluator.ts` is pure and returns `allowed | soft_block | hard_block` with a reason code. Every evaluation is persisted to `execution_authorizations`. See [docs/contracts/weekly-operating-contract.md](docs/contracts/weekly-operating-contract.md).

## Future: WebmasterID integration

Every Signal-generated outbound link reserves a structured set of parameters (`utm_source`, `utm_medium`, `utm_campaign`, `signal_campaign_id`, `signal_item_id`, `product_id`, `platform`, `account_id`). When WebmasterID is connected, the analytics page will resolve these into per-product and per-account attribution. Until then, the page shows "data not yet connected." Signal does not fake numbers.

## Future: Supabase persistence

The mock module in `src/lib/mock` is the contract for persistence. When Supabase is introduced, real queries will return the same shapes the mock data does today. No page changes will be required.

See [docs/roadmap.md](docs/roadmap.md) for the full plan.

## Getting started

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Quality checks

```bash
npm run lint
npm run typecheck
npm run build
```

## Repository

[github.com/PetroTitan/Signal](https://github.com/PetroTitan/Signal)
