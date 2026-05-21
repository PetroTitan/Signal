# Workflow map

Route: [/workflow](../../src/app/(app)/workflow/page.tsx)

A static, visual walk through Signal's twelve-stage operating loop. Useful for:

- founder onboarding,
- future team onboarding,
- architecture and PR review,
- documentation handoff.

## The twelve stages

1. **Product profile** — configuration. Voice, CTA constraints, risk tolerance.
2. **Account setup** — configuration. Wizard, 14-day warm-up, manual checklist.
3. **Source insight** — intelligence. Founder-observed reality enters the system.
4. **Platform adaptation** — intelligence. Per-platform opportunities and drafts.
5. **Comment / discussion opportunity** — intelligence. Participate / watch / skip.
6. **Risk analysis** — operations. Deterministic scoring, blocked flags surface here.
7. **Approval queue** — operations. One calm weekly review.
8. **Scheduler** — operations. Cadence-aware placement.
9. **Backlog** — operations. Holds, restores, no expiry.
10. **Platform command centers** — platform. Reddit, X, LinkedIn, Google lenses.
11. **Discoverability loop** — platform. Search-to-social + social-to-search.
12. **WebmasterID analytics** — future. Reserved slot for real data.

Each card on the page shows:

- inputs (what the stage reads),
- outputs (what it produces),
- routes (where to open the stage in the app).

## Voice

- No marketing language.
- No "powered by AI."
- Stages are named after their job, not their technology.
- Future stages are labeled explicitly as future.

## What this is not

- Not a marketing page.
- Not a sales tour.
- Not a step-by-step tutorial.

## How to evolve it

When the operating loop gains a new stage (e.g. a "publishing" stage when platform APIs ship), append a new `Stage` to the array in `src/app/(app)/workflow/page.tsx`. The visual flow auto-extends. No styling rewrites required.
