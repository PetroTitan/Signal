# Signal brand assets

## The approved artwork

`signal-logo-source.png` is the concept the owner approved: a blue
geometric S built from two ribbons, three ascending bars in the negative
space, and a "Signal" wordmark.

It is kept here **as a reference only**. Nothing in the interface loads
it. It is a 2,000px raster on a near-white background, which is the
wrong thing to put in a 16px favicon or a sidebar.

### A note on the filename

The path given when this work was commissioned —
`exec-da7a4737c-7ace-4d88-b935-b77819de0e1e.png` — does not exist, and
the stated "correction" repeated the same string. Three candidates were
present in that directory and all three showed the same concept. The one
copied here is the one that matches the attached approval image exactly.
The other two were rejected for specific reasons, recorded so the choice
can be checked:

- `exec-d8a4737c-…` has a transparency checkerboard **painted into the
  pixels**. It is not transparent; it is a picture of transparency.
- `exec-e9667bf3-…` applies a subtle gradient across the S, which the
  brief rules out.

## What ships

The mark is **recreated as code-native SVG geometry** in
`src/components/brand/signal-logo.tsx`, measured from the artwork:

| Property | Value |
| --- | --- |
| Symbol proportions | 37.5 × 48 (w:h = 0.781) |
| Band slope | 0.455 (≈24.5°) |
| Band thickness | 12.3 units, vertical |
| Cap radius | 9.212 — the radius that is tangent to the band's top edge and puts the cap's outermost point on the symbol edge |
| Signal blue | `#1F58D9` (`--signal-500`) |
| Deep navy | `#0A2360` (`--signal-900`) |

`signal-logo-recreation-overlay.png` is the artwork, the recreation and
the two superimposed. The overlap is near-total.

### Two deliberate departures

Both are cleanups a designer would make when taking a concept to
production, not redesigns:

1. **The ribbons are exact 180° rotations of each other.** The artwork
   was about 1.8 units out of symmetry.
2. **The bar spacing is even.** The artwork's gaps were 2.6 units while
   symmetry implies 3.19.

### Colour

The artwork's blue samples as `#015BFE`, brighter than the brand's
`#1F58D9`. The brief is explicit that the existing brand colours are
preserved, and both already exist as design tokens, so the mark uses the
tokens. No new colour system was introduced.

## Generated assets

All derived from the same path data:

| File | Purpose |
| --- | --- |
| `src/app/icon.svg` | Browser tab icon. Transparent, bars kept. |
| `src/app/favicon.ico` | 16 and 32 frames, transparent. |
| `src/app/apple-icon.png` | 180×180. **Opaque navy** — iOS composites home-screen icons on a tile and renders transparency black. |
| `public/icon-192.png`, `public/icon-512.png` | Web manifest, transparent. |
| `src/app/opengraph-image.png`, `src/app/twitter-image.png` | 1200×630 social preview. |

## Size behaviour

The three bars are dropped below 24px. This was measured, not assumed:
rendered at 4× and inspected, the bars are a smudge at 16px and still
mushy at 20px, and first read as three distinct bars at 24px. Below that
the S silhouette carries the mark on its own —
`BARS_LEGIBLE_ABOVE_PX` in the component is the single place that
threshold lives.
