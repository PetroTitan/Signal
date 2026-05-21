# Account onboarding

Signal makes account onboarding extremely convenient while staying OAuth-first and platform-safe. Signal **prepares** accounts; it does not **create** them.

## The four-step wizard

The wizard at [/accounts/new](../../src/app/(app)/accounts/new/page.tsx) walks the founder through four steps:

1. **Choose a platform** — Reddit, X, or LinkedIn. The choice shapes tone, cadence, and the warm-up plan.
2. **Choose a product** — selects positioning, allowed CTAs, and the campaign prefix.
3. **Choose a role** — Founder, Product, Support, Research, or Community. Roles produce different bios, content ideas, and warm-up plans.
4. **Generate kit** — Signal renders a deterministic setup kit and the founder picks a display name. On confirm, the account is created in the store with status `planned`.

## What the kit contains

- Username ideas
- Display name suggestions
- Bio / headline (three variations)
- About / profile text
- Avatar brief
- Cover / banner brief
- 10 non-promotional content ideas
- 10 comment / reply ideas
- 14-day warm-up plan with a focus tag per day
- Tone reminders and a cadence note
- Platform-specific extras (Reddit subreddit discovery, X pinned post, LinkedIn featured link)
- Manual setup checklist with stable IDs

## What Signal never asks for

- Platform passwords
- Cookies, session tokens, recovery codes, 2FA codes
- Proxy settings, fingerprint configuration, anti-detect tooling

The wizard, the detail page, and the accounts list all surface this explicitly.

## Lifecycle

```
planned → setup_needed → awaiting_manual_creation
        → ready_to_connect → connected
        → warming → active
              ↘ paused
```

Statuses are mutable from the detail page. The "Mark ready for weekly planning" action ticks the corresponding checklist item and bumps the account to `connected` (if OAuth is connected) or `ready_to_connect` (otherwise).

## Eligibility for weekly planning

Eligible statuses: `warming`, `active`, `connected`, `ready_to_connect`.
Not eligible: `planned`, `setup_needed`, `awaiting_manual_creation`, `paused`.

Eligibility surfaces:
- on the accounts list (chip)
- on the dashboard accounts list
- on the detail page (tile + reason)
- on the weekly plan table next to the account name

See [account-readiness-scoring.md](./account-readiness-scoring.md) for how readiness is computed, and [account-warm-up-workflow.md](./account-warm-up-workflow.md) for how the 14-day warm-up is structured.
