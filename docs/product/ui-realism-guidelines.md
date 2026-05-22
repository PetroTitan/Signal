# UI realism guidelines

Signal aims for the visual feel of Linear, Stripe, Raycast, and Vercel — calm, restrained, infrastructure-grade. This document captures the rules so future contributors don't pull the product back toward demo-template aesthetics.

## Layout rhythm

- **Page width.** Operational pages cap at `max-w-4xl` or `max-w-5xl`. Wider only when content genuinely needs it (e.g. scheduler grid uses `max-w-6xl`).
- **Page padding.** `px-6 lg:px-10 py-8` on the page wrapper. Inside, cards live on `space-y-3` to `space-y-6`.
- **Card padding.** `p-4` for compact cards, `p-5` for content cards, `card-padded` (`p-5`) for stat tiles. No `p-8` or larger inside cards.
- **Border treatment.** Single `border-ink-100` on cards, with `shadow-card`. No double borders, no thick borders, no accent borders for decoration.

## Typography

- **Page title.** `text-xl font-semibold tracking-tight`.
- **Section titles inside cards.** `text-sm font-semibold` — not `text-base` or larger.
- **Body copy.** `text-sm` with `leading-relaxed`. Captions and metadata use `text-xs text-ink-500`.
- **No more than two typography sizes in a single card.**

## Color

- The system uses three palettes: `ink` (slate), `signal` (one calm blue), and the risk tones (emerald / amber / red). Nothing else.
- `blocked` risk is the only state that uses `bg-ink-900 text-white`; it is not used elsewhere.
- No gradients. No neon. No glow effects beyond the subtle `shadow-card`.

## Cards vs lists

- **Lists are preferred over grids** for surfaces that contain `n` similar things (opportunities, discussions, comments, items). A vertical list with comfortable spacing is calmer than a 3-column grid.
- **Grids are allowed** for fixed-shape surfaces like the scheduler's Mon–Sun layout.
- **Stat-tile grids are limited** to four items max, and only when they answer "what should I look at first." Otherwise the data goes inside the relevant section.

## Empty states

- Every list-style surface has an empty state.
- The empty state is one short sentence, no card, no icon, centered, vertical padding of `py-12`.
- Empty states never use "0" or "—" as a placeholder.
- Empty states guide where useful: "Open discussions to see where to participate."

## Page topbar

- Title only. One sentence of description.
- No workspace badge, no breadcrumb, no greeting.
- Actions on the right: one primary button max, plus a small search icon link.

## Action density

- **One primary action per section.** The approval queue's item card has Approve as the only primary button; everything else is secondary or ghost.
- **Maximum four buttons** on any single item-card footer. Soften-rewrite-rewrite-delay-pause-convert-duplicate-reject is too many; pick the most common four.
- **Hide rarely-used actions** behind a small "more" menu when they exist (deferred until we genuinely need them).

## Badges

- Two badge tones inside a single row max.
- Badges read as labels, not as decoration. If a badge isn't carrying information someone scans for, remove it.
- Numbers go inside badges only when the number is the meaning (e.g. risk score next to the level).

## Copy

- **Plain operational language.** Never "operational surface", "intelligence layer", "cross-channel system."
- **Verbs first** in action labels: "Approve", "Soften", "Move to backlog", "Skip".
- **Calm certainty.** "Data not connected" not "data unavailable." "No connected account yet" not "no account."
- **No exclamation marks.** No emojis in body copy.

## Brand

- The brand mark is the `BrandMark` component (a small starburst SVG using `currentColor`). It appears in two places: the sidebar header and the marketing layout header.
- No additional logo placements (no favicons, no watermarks, no decorative repetitions on cards).

## Loading and motion

- Default Next.js behavior; no skeleton loaders, no spinners.
- Transitions are CSS-only: `transition-colors` on hover, no fancy enter/leave animations.

## When in doubt

Cut. Less is the brand.
