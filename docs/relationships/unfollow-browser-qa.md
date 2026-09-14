# Browser QA — automatic unfollowing

Reproducible procedure for the responsive sweep, and what it measured.

## Why this is not a committed test

Playwright is not a dependency of this repository, so a committed test
that needed it would fail in CI. The class-token controls in
`src/app/(app)/relationships/unfollow/mobile-layout.test.ts` are what
keep the fixes from being refactored away; this document is how the
measurements were taken, so anyone can repeat them.

Those controls are also, deliberately, not a substitute. **A node test
cannot measure an overflow.** The class assertions passed before this
sweep ran, and would have passed whatever it found.

## Procedure

1. `npx next build` — the sweep uses the real compiled stylesheet from
   `.next/static/css`, not a hand-written one.
2. Render the real components with `react-dom/server` into a static
   page carrying that stylesheet. They are client components, so only
   `useFormState`, `useFormStatus` and `next/link` are stubbed; every
   class and every element is the shipped one. The harness is
   `src/core/bluesky-unfollow/render-qa.test.ts` (skipped by default —
   see below).
3. Feed it **deliberately hostile content**: a 54-character unbreakable
   handle, a full 38-character DID, a 51-character campaign name, a
   long protection reason, a 33-character IANA timezone
   (`America/Argentina/ComodRivadavia`) and six-figure counts. These
   are what actually push a flex row past 320px.
4. Load it in Chromium at 320, 375, 390, 768 and 1280 and measure
   `documentElement.scrollWidth − clientWidth`, every element whose box
   escapes the viewport, and the height of every interactive element.

Surfaces measured: the setup wizard, the activation confirmation dialog
(forced open), the Never-unfollow panel, and the campaign controls
including both destructive confirmations.

## Results

| Width | Page overflow | Escaping elements | Targets measured | Choice-row heights |
| --- | --- | --- | --- | --- |
| 320 | **0** | 0 | 44 | 92 / 134 / 157 px |
| 375 | **0** | 0 | 44 | 92 / 114 / 134 px |
| 390 | **0** | 0 | 44 | 92 / 114 px |
| 768 | **0** | 0 | 44 | 69 px |
| 1280 | **0** | 0 | 44 | 69 px |

Every button, link, input and select measured **≥ 44 px** tall at every
width.

## The one thing under 44px, and why it is not a defect

Radio and checkbox **glyphs** measure 20px. The tap target is the
enclosing `<label>` row, which measures 69–157px.

That is a claim, so it was tested rather than asserted. At 320px, a
click **203 px away from the glyph**, near the opposite edge of the
row:

| Control | Before | After | Distance from glyph | Row height |
| --- | --- | --- | --- | --- |
| Source radio (`follow_campaign`) | unchecked | **checked** | 203 px | 92 px |
| Dry-run checkbox | checked | **unchecked** | 203 px | 157 px |

The glyphs were raised from the browser default 13px to 20px
(`h-5 w-5`) during this sweep — not for the target size, which the row
already satisfies, but because a 13px glyph is hard to see and "the
whole row is clickable" is not obvious from looking at it.

## Limits of this sweep

- It renders the components **in isolation**, not inside the running
  application, because serving the real page needs a Supabase project
  this environment does not have. Page chrome (sidebar, mobile nav) is
  covered by `src/test/ui-contract.test.ts`.
- The dialog is measured with `dialog.show()` rather than `showModal()`,
  because a static harness has no top layer. Its box, classes and
  content are the shipped ones; the backdrop is not measured.
- The campaign **detail page** is a server component and is not in the
  harness. Its member table is the one wide element on it, and it is
  wrapped in `overflow-x-auto` with `min-w-[32rem]` — asserted by the
  class-token control, **not measured here**, and recorded as such.

## Repeating it

```
npx next build
npx vitest run src/core/bluesky-unfollow/render-qa.test.ts   # writes /tmp/unfollow-qa/index.html
<playwright python> /tmp/sweep.py                            # the measurement script
```

The render harness is committed with `describe.skip` so it does not run
in CI (it writes outside the repository). Remove the `.skip` to
regenerate the page.
