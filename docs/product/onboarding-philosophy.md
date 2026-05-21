# Onboarding philosophy

The first week with Signal teaches the operating model. The product is not "set up once and post." It is "configure deliberately, approve once a week, distribute calmly." The onboarding experience is shaped around that.

## Six steps, on purpose

The dashboard&apos;s [OnboardingChecklist](../../src/components/onboarding-checklist.tsx) carries six items:

1. **Configure product profiles** — voice, CTA policy, forbidden claims, risk tolerance.
2. **Set up at least one eligible account** — wizard + manual checklist + warm-up.
3. **Add a source insight** — observation, lesson, support pattern.
4. **Run a weekly review** — one calm pass through the approval queue.
5. **Redistribute the schedule** — staggered placement across the week.
6. **Scan discoverability opportunities** — search-to-social loop.

Each step deep-links to its surface. The card shows a live progress bar derived from current state, so the checklist is also a quiet status indicator across early use.

## What the wizard teaches

`/accounts/new` is the wizard. Four steps: platform → product → role → generate kit. It teaches three things at the moment of greatest attention:

- **Signal never asks for your platform password.** Stated on the first step.
- **Manual setup is the path.** Signal prepares the kit; the founder creates the account on the platform.
- **Warm-up matters.** The 14-day warm-up plan is shown before the account is created so the founder knows the cadence shape they&apos;re signing up for.

## Empty states teach, not blank

When a page is empty, it explains what the engine is waiting for and what to do next. Pattern across the app:

- Title — what&apos;s missing in one short sentence.
- Description — why this state exists and what to do.
- Action — a deep link to the most useful next surface.

The shared [EmptyState](../../src/components/empty-state.tsx) component carries this voice.

## The founder is the audience

Onboarding copy is calibrated to a founder running a small portfolio. It assumes:

- The founder already has a product.
- The founder already operates on at least one of Reddit / X / LinkedIn.
- The founder is skeptical of growth tooling that promises volume.
- The founder will skip anything that smells like AI hype.

What this rules out:

- "Generate your first 100 posts" framing.
- "10x your followers" framing.
- Anything that infers what the founder cares about from a quiz.

## The "why this matters" tone

Every step is accompanied by a short rationale. Not a marketing claim — the operational reason. Examples:

- *"Voice, CTA policy, forbidden claims, and risk tolerance for each product."*
- *"Signal turns insights into platform-native opportunities."*
- *"One calm pass through the approval queue."*
- *"Search-to-social, freshness windows, evergreen amplification — calm, deterministic recommendations."*

The rationale is what makes onboarding feel like learning a system, not flipping toggles.

## What onboarding never does

- No celebration screen.
- No streak counter.
- No "you&apos;re a power user" badge.
- No nudges to do more than the weekly cadence allows.
- No "AI did N things for you while you were away" — Signal does not do things while you&apos;re away.

The founder learns the operating model once. After that, the dashboard&apos;s operational panels are the primary surface.
