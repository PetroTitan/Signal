# Browser QA — automatic-following setup

Reproducible procedure for the responsive sweep, and what it found.

## Why this is not a unit test

Playwright is not a dependency of this repository, so a committed test
that needed it would fail in CI. The class-token controls in
`setup-flow.test.ts` are what keep the fixes from being refactored
away; this document is how the measurements were taken, so anyone can
repeat them.

Those controls are also, deliberately, not a substitute. A node test
cannot measure an overflow — and the sweep below found two defects that
every class assertion passed.

## Procedure

1. `npm run build` — the sweep uses the real compiled stylesheet from
   `.next/static/css`, not a hand-written one.
2. Render the real components with `react-dom/server` into a static
   page carrying that stylesheet. The wizard is a client component, so
   only `useFormState` and `useFormStatus` are stubbed; every class and
   every element is the shipped one.
3. Feed it deliberately hostile content: a 45-character unbreakable
   handle, a long campaign name, and six-figure counts. These are what
   actually push a flex row past 320px.
4. Load it in Chromium at 320, 375, 390, 768 and 1280 and measure
   `documentElement.scrollWidth − clientWidth`, every element whose
   right edge exceeds the viewport, and the height of every interactive
   element.

## What it found

**1. An 8px horizontal overflow on the setup screen at 320px.**

No single element was wider than the viewport, which is why it was
invisible to a "does any element exceed the width" check. The cause was
a bare `<fieldset>`: browsers give it `min-inline-size: min-content`
plus its own padding, so it refused to shrink and started 21px further
right than its container. Fixed with `m-0 min-w-0 border-0 p-0`.

**2. Radio and checkbox glyphs measured 13px.**

The tap target is the enclosing `<label>` row, not the glyph. Confirmed
by clicking 200px away from the control and observing the selection
change. The rows measure 66–86px, comfortably past 44. The glyphs were
still enlarged to 20px so they are easy to see and hit directly.

## Result after the fixes

| Width | Page overflow | Smallest tap target |
| --- | --- | --- |
| 320 | 0 | 44px (label rows 86px) |
| 375 | 0 | 44px (label rows 66px) |
| 390 | 0 | 44px (label rows 66px) |
| 768 | 0 | 44px (label rows 66px) |
| 1280 | 0 | 44px (label rows 66px) |

## Limits of this sweep

Steps 2 and 3 of the wizard are collapsed in the initial render, so
their controls were not measured directly. They use the same `input`
class that step 1 measures at exactly 44px, and the class-token control
asserts `min-h-11` on every one of them — but that is an inference, not
a measurement, and it is recorded here as such.

The sweep renders the components in isolation rather than inside the
running application, because serving the real page needs a Supabase
project this environment does not have. Page chrome (sidebar, mobile
nav) is covered by the existing `src/test/ui-contract.test.ts` and the
sweep recorded for earlier milestones.
