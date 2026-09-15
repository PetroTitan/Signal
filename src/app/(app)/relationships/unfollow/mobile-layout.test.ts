import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Mobile-layout contracts for the unfollow surface.
 *
 * These are CLASS-TOKEN PROXIES, not layout measurements, and the file
 * says so rather than implying otherwise: a node test cannot measure an
 * overflow. What it can do is make the specific defect that causes
 * overflow on these pages unrepresentable.
 *
 * The real-browser sweep at 320/375/390/768/1280 is recorded in the PR
 * report. This file is what keeps the fix from being refactored away
 * afterwards.
 *
 * THE DEFECT THESE EXIST FOR
 * --------------------------
 * A flex child defaults to `min-width: auto` and refuses to shrink
 * below its content's intrinsic width. These pages render DIDs —
 * `did:plc:z72i7hdynmk6r22z27h6tvur`, 32 unbreakable characters — and
 * AT-URIs, which are longer still. Without `min-w-0` on the flex child
 * and `break-all`/`break-words` on the text, one DID pushes its row
 * past 320px and the whole page scrolls sideways.
 */

function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const read = (rel: string) =>
  code(readFileSync(path.join(process.cwd(), rel), "utf8"));

const DIALOG = read("src/app/(app)/relationships/unfollow/_confirm-activation.tsx");
const WIZARD = read("src/app/(app)/relationships/unfollow/_unfollow-wizard.tsx");
const DETAIL = read("src/app/(app)/relationships/unfollow/[id]/_detail-view.tsx");
const CONTROLS = read("src/app/(app)/relationships/unfollow/[id]/_controls.tsx");
const ALLOWLIST = read("src/app/(app)/relationships/unfollow/_allowlist-panel.tsx");
const RELATIONSHIPS_PAGE = read("src/app/(app)/relationships/page.tsx");

const SURFACES: [string, string][] = [
  ["confirmation dialog", DIALOG],
  ["setup wizard", WIZARD],
  ["campaign detail", DETAIL],
  ["controls", CONTROLS],
  ["allowlist panel", ALLOWLIST],
];

describe("every interactive target is at least 44px tall", () => {
  it("each surface's buttons, links and inputs declare min-h-11", () => {
    // Tailwind's `min-h-11` is 2.75rem = 44px at the default root size,
    // which is the WCAG 2.5.8 target-size minimum.
    for (const [name, source] of SURFACES) {
      expect(source, name).toMatch(/min-h-11/);
    }
  });

  it("no submit or trigger is declared without one", () => {
    for (const [name, source] of SURFACES) {
      const buttons = source.match(/<button[^>]*className="[^"]*"/g) ?? [];
      for (const button of buttons) {
        // A `btn-*` class alone does not set a height; the token has to
        // be on the element.
        expect(`${name}: ${button}`, name).toMatch(/min-h-11|btn-(primary|secondary|danger-solid)/);
      }
    }
  });
});

describe("nothing can push a row past 320px", () => {
  it("every DID and AT-URI is rendered with a break class", () => {
    // `break-all` for identifiers (no natural break opportunities);
    // `break-words` for prose that may contain one.
    expect(DIALOG).toMatch(/actorLabel[\s\S]{0,200}break-all|break-all[\s\S]{0,200}actorLabel/);
    expect(DETAIL).toMatch(/subjectDid[\s\S]{0,200}break-all|break-all[\s\S]{0,300}subjectDid/);
    expect(ALLOWLIST).toMatch(/subjectDid[\s\S]{0,200}break-all|break-all[\s\S]{0,200}subjectDid/);
  });

  it("flex children that hold identifiers carry min-w-0", () => {
    for (const [name, source] of [
      ["allowlist panel", ALLOWLIST],
      ["setup wizard", WIZARD],
    ] as [string, string][]) {
      expect(source, name).toMatch(/min-w-0/);
    }
  });

  it("the member table scrolls INSIDE its own container", () => {
    // Wide content must scroll in its own box. A table that widens the
    // page makes the whole document scroll sideways, which moves the
    // header and every control with it.
    expect(DETAIL).toMatch(/overflow-x-auto/);
    expect(DETAIL).toMatch(/min-w-\[32rem\]/);
  });

  it("no surface declares a fixed pixel width", () => {
    for (const [name, source] of SURFACES) {
      expect(source, name).not.toMatch(/\bw-\[\d{3,}px\]/);
      expect(source, name).not.toMatch(/style=\{\{[^}]*width:\s*["']\d{3,}px/);
    }
  });

  it("the dialog is viewport-relative, not a fixed width", () => {
    // `max-w-lg` alone overflows a 320px viewport. The calc keeps a
    // 1rem gutter on each side at every width.
    expect(DIALOG).toContain("w-[calc(100vw-2rem)]");
  });

  it("a long dialog scrolls itself rather than the page", () => {
    expect(DIALOG).toContain("max-h-[85vh]");
    expect(DIALOG).toContain("overflow-y-auto");
  });
});

describe("controls stack rather than overflow on a narrow screen", () => {
  it("button rows wrap or stack below the sm breakpoint", () => {
    expect(CONTROLS).toMatch(/flex flex-col sm:flex-row sm:flex-wrap gap-2/);
    expect(DIALOG).toMatch(/flex flex-col-reverse sm:flex-row/);
  });

  it("the two header CTAs wrap instead of being pushed off the edge", () => {
    // Two 44px targets do not fit side by side at 320px, and a control
    // pushed off the edge is a control that does not exist.
    expect(RELATIONSHIPS_PAGE).toMatch(/flex flex-wrap gap-2[\s\S]{0,300}StartUnfollowCta/);
  });

  it("full-width on mobile, natural width from sm upward", () => {
    for (const [name, source] of [
      ["controls", CONTROLS],
      ["dialog", DIALOG],
      ["wizard", WIZARD],
    ] as [string, string][]) {
      expect(source, name).toMatch(/w-full sm:w-auto/);
    }
  });

  it("form grids collapse to one column on mobile", () => {
    expect(WIZARD).toMatch(/grid-cols-1 sm:grid-cols-2/);
    expect(DIALOG).toMatch(/grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2/);
  });
});

describe("the page container is bounded and padded at every width", () => {
  it("both pages use the app's responsive padding scale", () => {
    for (const [name, source] of [
      // The padding is the page wrapper's; the view renders inside it.
      ["detail", read("src/app/(app)/relationships/unfollow/[id]/page.tsx")],
      ["setup", read("src/app/(app)/relationships/unfollow/page.tsx")],
    ] as [string, string][]) {
      expect(source, name).toMatch(/px-4 sm:px-6 lg:px-10/);
      expect(source, name).toMatch(/max-w-\dxl/);
    }
  });
});
