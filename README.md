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

No daily notifications. No urgency. One review.

## Future: OAuth-first account model

Every account in Signal will connect through the platform's official authorization flow. Signal will never ask for, store, or transmit platform passwords. Until the OAuth providers are wired in, the accounts page exposes the model and the disabled connect controls.

See [docs/platforms/platform-adapters.md](docs/platforms/platform-adapters.md).

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
