# Browser QA — LinkedIn Sales workspace

Reproducible procedure for the responsive and keyboard sweep, and what it measured.
Date: 2026-09-15. Head of the branch at the time: the commit that adds this file.

## What was measured

The harness (`RENDER_QA=1 npx vitest run src/core/linkedin-sales/render-qa.test.ts`,
after `npx next build`) renders the real client components with
`react-dom/server` into one static page carrying the compiled stylesheet
from `.next/static/css` (85 KB page; the harness asserts the stylesheet is
present and larger than 10 KB, and the screenshots show it applied):

- the section navigation and the boundary notice (as the layout renders them)
- two task cards: one `manual_linkedin_message` in state `opened` with a
  4,000-character draft containing 300-character words, and one
  `manual_profile_review` with no draft
- the lead-list form, the import form, the sequence form, the campaign form
- two campaign control blocks (active, draft), with the cancel dialog forced open

**Hostile content**: a 214-character unbreakable profile slug, a
60-character name with no spaces, a 62-character company name, a
33-character timezone (`America/Argentina/ComodRivadavia`), and a campaign
name that must wrap.

`useFormState`, `useFormStatus`, `next/link` and `usePathname` are stubbed;
every class and element is the shipped one.

The sweep (`/tmp/linkedin-qa/sweep.py`, Playwright Chromium) loads the page at
320, 375, 390, 768 and 1280 and measures `documentElement.scrollWidth −
clientWidth`, every element whose box escapes the viewport outside an
ancestor that scrolls horizontally within it, and the size of every
`button`, `a[href]`, `input`, `select`, `textarea`, `[role=button]` and
`summary`.

## Results — final run

| Width | Page overflow | Escaping elements | Controls measured | Under 44 × 44 |
| --- | --- | --- | --- | --- |
| 320 | **0** | 0 | 57 | 0 |
| 375 | **0** | 0 | 57 | 0 |
| 390 | **0** | 0 | 57 | 0 |
| 768 | **0** | 0 | 57 | 0 |
| 1280 | **0** | 0 | 57 | 0 |

Checkbox and radio glyphs (10) are 20 px; their enclosing `<label>` rows
measure **44 px** at every width. That the row is the target was tested,
not asserted: at 320 px a click **200 px from the glyph centre** (the row
is 283 px wide) toggled both the "I did this step on LinkedIn myself"
checkbox and the cancel dialog's confirmation checkbox from unchecked to
checked.

Screenshots: `/tmp/linkedin-qa/shot-<width>.png` (not committed).

## What the first run found, and the fix

The first run reported 0 overflow and 0 escaping elements at every width,
but the glyph measurement showed radio and checkbox inputs at **18 px and
13 px** at 320 px: a flex item beside long label text shrinks. Every glyph
now carries `shrink-0`, and `mobile-layout.test.ts` requires it. After the
fix every glyph measures 20 px at every width.

The first click test also "failed" — for a different reason: it clicked at
a document coordinate 1,500 px down without scrolling, so nothing was
under the pointer. The test now scrolls the row into view first. Recorded
because a QA script that cannot fail for the right reason is not evidence.

## Keyboard

At 320 px, with the dialogs closed, a Tab walk reached **every** focusable
control on the page (60 counted; 65 Tab stops, because Chromium gives date
and time inputs internal segments). Each stop was checked for a painted
focus indicator (`box-shadow` or a non-zero outline):

- buttons, links, text inputs, selects, textareas, summaries: ring painted
- date and time inputs: the walk's first reading said "no ring", which a
  direct probe disproved — focusing them paints the ring and a 2 px
  outline (`:focus`, `:focus-visible` and `:focus-within` all match). The
  walk read the style while focus was on an internal segment.

Cancel dialog (`showModal()`): Tab cycles through the confirmation
checkbox and the two buttons and then the document body (headless
wrap-around), never an outside control; `focus()` on a navigation link
outside the dialog does not take focus (the rest of the document is
inert); `elementFromPoint` over that link returns nothing (the backdrop
covers it); **Escape closes it**.

Screen-reader semantics are class-token controlled in
`mobile-layout.test.ts`: `aria-current="page"` on the section tab,
`aria-label` on both navigation landmarks, `fieldset`/`legend` on every
grouped choice, `role="alert"` and `role="status"` on every form result,
an `aria-live="polite"` region for the copy confirmation, a screen-reader
suffix on the new-tab link, and a labelled heading for every section.

## Limits of this sweep

- Components are rendered **in isolation**, not inside the running
  application: serving the real pages needs a Supabase project this
  environment does not have. Page chrome (sidebar, mobile nav) is covered
  by `src/test/ui-contract.test.ts` and the manifest guard.
- The server pages (overview, leads table, sequences list, campaigns list,
  analytics, compliance) are not in the harness. Their wide elements are
  tables, each wrapped in `overflow-x-auto` with a `min-w-[…rem]` — asserted
  by the class-token control, **not measured here**, and recorded as such.
- The dialog is measured with `show()` in the sweep (no top layer in a
  static page) and with `showModal()` in the keyboard probe.
- No live LinkedIn page was opened. The "Open in LinkedIn" link is an
  ordinary anchor; the sweep measured its size, not its destination.

## Repeating it

```
npx next build
RENDER_QA=1 npx vitest run src/core/linkedin-sales/render-qa.test.ts   # writes /tmp/linkedin-qa/index.html
~/.claude/skills/seo/.venv/bin/python /tmp/linkedin-qa/sweep.py         # overflow, escaping, control sizes
~/.claude/skills/seo/.venv/bin/python /tmp/linkedin-qa/rows.py          # label rows + far-from-glyph click
~/.claude/skills/seo/.venv/bin/python /tmp/linkedin-qa/keyboard.py      # tab walk, focus rings, modal
```

The scripts live outside the repository because Playwright is not a
dependency here; they are reproduced in full in this document's history
and are short enough to re-type.
