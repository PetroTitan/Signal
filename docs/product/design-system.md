# Design system

Signal's design system is small on purpose. It is a calm, infrastructure-grade visual language — no gradients, no flashy accent colors, no template aesthetics.

## Tokens

Tailwind extends with three semantic palettes:

- **`ink`** — neutral slate, 50–950. The foreground for nearly everything: text, borders, dividers, surfaces.
- **`signal`** — calm blue, 50–900. Used for primary actions, links, the active nav state, and the "info" tone.
- **Risk tones** — emerald, amber, red used in the badge classes for low / medium / high. A fourth tone (`bg-ink-900 text-white`) is the explicit `blocked` style.

There is no purple, no teal, no orange-yellow gradient, no neon. The accent is one color.

## Component primitives

Defined in `src/app/globals.css` via `@layer components`:

| Class | Purpose |
|---|---|
| `.card` | Base white surface with the soft `shadow-card`. |
| `.card-padded` | `.card` + `p-5`. |
| `.badge` | Pill-shape base. |
| `.badge-neutral` / `-info` / `-low` / `-medium` / `-high` | Tone variants. |
| `.btn` | Default button. Quiet, calm, with the focus ring. |
| `.btn-primary` | Signal-blue primary. |
| `.btn-ghost` | Transparent. |
| `.section-title` / `.stat-label` / `.stat-value` | Typography presets. |
| `.row-divider > * + *` | Single-token row dividers. |

The component class layer keeps page code tight and the visual language consistent.

## Shared React primitives

| Component | Purpose |
|---|---|
| `Topbar` | Page header with workspace, title, description, optional actions, search affordance. |
| `Sidebar` / `MobileNav` | Navigation shells. |
| `SectionHeader` | Consistent section header inside a card. |
| `EmptyState` | Calm empty surface with optional action links. |
| `Explain` + `Why*` wrappers | Reusable explainability cards. |
| `TrustPanel` | The single source of OAuth-first trust messaging. |
| `PageIntro` | Calm one-paragraph page intro. |
| `OnboardingChecklist` | First-week setup card for the dashboard. |
| `Stepper` | Multi-step flows (used by the account wizard). |
| `Badges` | Platform badge, account status badge, risk badge, eligibility badge. |
| `OperationsPanels` | Dashboard's four operational surfaces. |

## Voice rules

- No "AI" superlatives.
- No emojis in body copy.
- No exclamation marks.
- Numbers and concrete examples instead of adjectives.
- "Recommended cooldown", "Move to backlog", "Soften the CTA" — these are the canonical phrasings.

## Layout rhythm

- Top-level pages use `px-6 lg:px-8 py-6 max-w-7xl space-y-6`.
- Narrower content pages (settings, account detail) use `max-w-5xl` or `max-w-3xl`.
- Cards stack vertically by default; grids switch in at `md:` and `lg:` breakpoints.
- Hero / intro cards take the same surface treatment as everything else — no dedicated hero gradient.

## Accessibility

- Skip-link in the root layout, with a global `.skip-link` rule.
- `:focus-visible` rule on `a`, `button`, `input`, `select`, `textarea`, and `[role="button"]` with a calm two-ring focus indicator.
- The `<main id="main-content">` landmark in both the app shell and the marketing layout receives the skip-link.
- All buttons are real `<button>` elements with `type="button"` by default; links are `<Link>`.

## Mobile rhythm

- The sidebar is desktop-only (`hidden lg:flex`). On mobile a bottom `MobileNav` shows the five most-used operations.
- Tables in `.overflow-x-auto` scroll horizontally on small screens rather than collapsing.
- Dense grids degrade to single columns at `md:` boundaries.

## What this system never does

- It never introduces a new accent color for a single feature.
- It never inlines a one-off design token in a page.
- It never relies on a generated "AI" component library.
- It never uses a Tailwind template starter aesthetic (gradient hero, marquee logos, etc.).

Productization polish hardened the system. It did not rebuild it.
