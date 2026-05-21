# Signal

Sustainable growth operations for founders and SaaS teams.

Signal is an AI-assisted growth operations platform. It does one thing well: turn a founder's intention to "show up consistently" into a calm weekly workflow — a single plan, a single approval, and an organic distribution across the week.

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
- No database, no Supabase, no Stripe, no real AI APIs, and no platform OAuth integrations yet.
- All data lives in `src/lib/mock` and is imported directly into pages.

See [docs/architecture/mvp-architecture.md](docs/architecture/mvp-architecture.md) for the source layout and conventions.

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
