/**
 * The Signal brand mark — one canonical component.
 *
 * Every surface that shows the logo renders this. Copying SVG markup
 * around is how a rebrand ends up half-finished: the old radial mark
 * lived in exactly two files and was still missed on the auth pages,
 * the favicon and the social preview, because those never had a logo at
 * all.
 *
 * THE GEOMETRY
 * ------------
 * Recreated from the approved artwork as code-native geometry, not
 * traced and not embedded as a raster. Kept faithful to the source's
 * silhouette, proportions and meaning:
 *
 *   - two ribbons forming an S, each a band of constant vertical
 *     thickness (12.3 units) slanted at the source's ~24.5 degrees;
 *   - each ribbon ends in a circular cap of radius 9.212, which is the
 *     radius that makes the cap exactly tangent to the band's top edge
 *     and puts its outermost point on the symbol's edge;
 *   - three ascending bars in the negative space — two drawn, the third
 *     formed by the lower ribbon's leading edge, exactly as the source
 *     composes it.
 *
 * Two deliberate departures from the artwork, both cleanups rather than
 * redesigns: the two ribbons are now exact 180-degree rotations of each
 * other (the source was ~1.8 units out), and the bar spacing is even.
 * The measured artwork is kept in `docs/brand/` for comparison.
 *
 * Authored in a 37.5 x 48 space — the source's own proportions — so the
 * mark can never be stretched: every variant places that box inside its
 * viewBox rather than scaling the axes independently.
 */

import type { CSSProperties } from "react";

/** The symbol's own coordinate space. Width : height = 37.5 : 48. */
const SYMBOL_WIDTH = 37.5;
const SYMBOL_HEIGHT = 48;

/**
 * A square window around the symbol.
 *
 * The negative min-x centres the 37.5-wide symbol in a 48 box, so no
 * transform is needed and the path data is byte-identical in every
 * variant. Full height with no vertical padding: at favicon sizes every
 * pixel counts, and the S is tall and narrow enough that it still sits
 * comfortably beside text.
 */
const SQUARE_VIEWBOX = "-5.25 0 48 48";
const NATURAL_VIEWBOX = `0 0 ${SYMBOL_WIDTH} ${SYMBOL_HEIGHT}`;

const UPPER_RIBBON =
  "M5.397 11.615L29.666 0.571Q31.850 -0.423 31.850 1.977L31.850 9.477Q31.850 11.877 29.665 12.871L10.668 21.515Q9.212 22.177 9.212 23.777L9.212 29.212A9.212 9.212 0 0 1 5.397 11.615Z";
const LOWER_RIBBON =
  "M32.103 36.385L7.834 47.429Q5.650 48.423 5.650 46.023L5.650 38.523Q5.650 36.123 7.835 35.129L26.832 26.485Q28.288 25.823 28.288 24.223L28.288 18.788A9.212 9.212 0 0 1 32.103 36.385Z";
const BAR_ONE =
  "M13.398 24.094L16.156 22.839Q17.157 22.384 17.157 23.484L17.157 28.784Q17.157 29.884 16.156 30.339L13.398 31.594Q12.397 32.049 12.397 30.949L12.397 25.649Q12.397 24.549 13.398 24.094Z";
const BAR_TWO =
  "M21.343 19.179L24.101 17.924Q25.102 17.469 25.102 18.569L25.102 25.169Q25.102 26.269 24.101 26.724L21.343 27.979Q20.342 28.434 20.342 27.334L20.342 20.734Q20.342 19.634 21.343 19.179Z";

export const SIGNAL_LOGO_PATHS = {
  upperRibbon: UPPER_RIBBON,
  lowerRibbon: LOWER_RIBBON,
  barOne: BAR_ONE,
  barTwo: BAR_TWO,
} as const;

export const SIGNAL_LOGO_VIEWBOX = {
  square: SQUARE_VIEWBOX,
  natural: NATURAL_VIEWBOX,
} as const;

/**
 * Below this the bars stop being bars.
 *
 * Measured, not guessed. Rendered at 4x and inspected: at 16px the bars
 * are a smudge, and at 20px they are still mushy — the gaps close up
 * under antialiasing. They first read as three distinct bars at 24px.
 * Below that the mark drops them and lets the S silhouette, which
 * survives perfectly, carry it alone.
 */
export const BARS_LEGIBLE_ABOVE_PX = 24;

type Tone = "brand" | "mono";

interface SymbolProps {
  size: number;
  tone: Tone;
  /** Force the simplified form regardless of size. */
  simplified?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Rendered only when the logo carries meaning on its own. */
  label?: string;
}

/**
 * The icon, on its own.
 *
 * Decorative by default: the logo almost always sits beside the word
 * "Signal", and announcing it again gives the same link two names.
 * Passing `label` opts into `role="img"` with a `<title>` for the cases
 * where it stands alone.
 */
function SignalSymbol({
  size,
  tone,
  simplified,
  className,
  style,
  label,
}: SymbolProps) {
  const showBars = simplified === true ? false : size >= BARS_LEGIBLE_ABOVE_PX;
  const ribbonFill = tone === "mono" ? "currentColor" : "rgb(var(--signal-500))";
  const decorative = !label;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={SQUARE_VIEWBOX}
      // Both dimensions are set, so the box is reserved before paint
      // and nothing reflows when the SVG resolves.
      width={size}
      height={size}
      className={className}
      style={style}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={undefined}
      focusable="false"
    >
      {label ? <title>{label}</title> : null}
      <g fill={ribbonFill}>
        <path d={UPPER_RIBBON} />
        <path d={LOWER_RIBBON} />
        {showBars ? (
          <>
            <path d={BAR_ONE} />
            <path d={BAR_TWO} />
          </>
        ) : null}
      </g>
    </svg>
  );
}

export type SignalLogoVariant = "mark" | "lockup" | "monochrome";

export interface SignalLogoProps {
  /**
   * `mark` — icon only, square, for constrained navigation and icons.
   * `lockup` — icon plus the word Signal, for auth and marketing.
   * `monochrome` — icon only, inheriting `currentColor`.
   */
  variant?: SignalLogoVariant;
  /** Height of the icon in px. The lockup sizes its text from this. */
  size?: number;
  className?: string;
  /**
   * The accessible name, when the logo is the only thing identifying
   * Signal. Leave it off next to visible "Signal" text — the default is
   * decorative, which is the common case and avoids a second name on
   * the same control.
   */
  label?: string;
  /** Force the small-size form (no bars) at any size. */
  simplified?: boolean;
}

export function SignalLogo({
  variant = "mark",
  size = 24,
  className,
  label,
  simplified,
}: SignalLogoProps) {
  if (variant !== "lockup") {
    return (
      <SignalSymbol
        size={size}
        tone={variant === "monochrome" ? "mono" : "brand"}
        simplified={simplified}
        className={className}
        label={label}
      />
    );
  }

  // The wordmark is real text, not outlines: it stays crisp at every
  // size and zoom level, it is selectable and translatable, and screen
  // readers get the product name without a duplicate from the icon.
  return (
    <span
      className={`inline-flex items-center gap-2 ${className ?? ""}`.trim()}
      data-testid="signal-lockup"
    >
      <SignalSymbol size={size} tone="brand" simplified={simplified} />
      <span
        className="font-semibold tracking-tight text-signal-900 leading-none"
        style={{ fontSize: Math.round(size * 0.82) }}
      >
        Signal
      </span>
    </span>
  );
}
