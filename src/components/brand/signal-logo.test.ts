import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  SignalLogo,
  SIGNAL_LOGO_PATHS,
  BARS_LEGIBLE_ABOVE_PX,
} from "./signal-logo";

/**
 * The brand mark: one component, every surface.
 *
 * Rendered for real rather than inspected as source, because the things
 * that matter here — which paths are drawn at which size, whether the
 * SVG is announced, whether the box is reserved — are properties of the
 * output, not of the file.
 */

/** This file, so the source sweeps below can exclude themselves. */
const SELF = "signal-logo.test.ts";

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(el);

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

describe("every supported variant renders", () => {
  it("mark draws the two ribbons", () => {
    const html = render(createElement(SignalLogo, { variant: "mark", size: 32 }));
    expect(html).toContain("<svg");
    expect(html).toContain(SIGNAL_LOGO_PATHS.upperRibbon);
    expect(html).toContain(SIGNAL_LOGO_PATHS.lowerRibbon);
  });

  it("lockup draws the mark and the word Signal", () => {
    const html = render(createElement(SignalLogo, { variant: "lockup", size: 24 }));
    expect(html).toContain(SIGNAL_LOGO_PATHS.upperRibbon);
    expect(html).toContain("Signal");
    expect(html).toContain("signal-lockup");
  });

  it("monochrome inherits currentColor and never hardcodes the brand blue", () => {
    const mono = render(
      createElement(SignalLogo, { variant: "monochrome", size: 24 }),
    );
    expect(mono).toContain('fill="currentColor"');
    expect(mono).not.toContain("--signal-500");

    // The colour variants do use the token, not a literal hex — one
    // colour system, not two.
    const brand = render(createElement(SignalLogo, { variant: "mark", size: 24 }));
    expect(brand).toContain("rgb(var(--signal-500))");
    expect(brand).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
});

describe("the three ascending bars", () => {
  it("are drawn at 24px and above", () => {
    for (const size of [24, 32, 48, 64]) {
      const html = render(createElement(SignalLogo, { variant: "mark", size }));
      expect(html, `${size}px`).toContain(SIGNAL_LOGO_PATHS.barOne);
      expect(html, `${size}px`).toContain(SIGNAL_LOGO_PATHS.barTwo);
    }
  });

  it("are dropped below the legibility threshold instead of blurring", () => {
    for (const size of [16, 20]) {
      const html = render(createElement(SignalLogo, { variant: "mark", size }));
      expect(html, `${size}px`).not.toContain(SIGNAL_LOGO_PATHS.barOne);
      // The silhouette still carries the mark.
      expect(html, `${size}px`).toContain(SIGNAL_LOGO_PATHS.upperRibbon);
      expect(html, `${size}px`).toContain(SIGNAL_LOGO_PATHS.lowerRibbon);
    }
    expect(BARS_LEGIBLE_ABOVE_PX).toBe(24);
  });

  it("can be simplified explicitly at any size", () => {
    const html = render(
      createElement(SignalLogo, { variant: "mark", size: 48, simplified: true }),
    );
    expect(html).not.toContain(SIGNAL_LOGO_PATHS.barOne);
  });
});

describe("accessibility", () => {
  it("is decorative by default", () => {
    // The common case is beside visible "Signal" text, where a second
    // name on the same control is worse than none.
    const html = render(createElement(SignalLogo, { variant: "mark", size: 20 }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("<title>");
    expect(html).not.toContain('role="img"');
  });

  it("takes an accessible name when it stands alone", () => {
    const html = render(
      createElement(SignalLogo, { variant: "mark", size: 32, label: "Signal" }),
    );
    expect(html).toContain('role="img"');
    expect(html).toContain("<title>Signal</title>");
    expect(html).not.toContain('aria-hidden="true"');
  });

  it("never carries two accessible names at once", () => {
    const html = render(
      createElement(SignalLogo, { variant: "mark", size: 32, label: "Signal" }),
    );
    expect(html).not.toContain("aria-label");
  });

  it("the lockup's icon is silent — its own text is the name", () => {
    const html = render(createElement(SignalLogo, { variant: "lockup", size: 24 }));
    expect(html).toContain('aria-hidden="true"');
    expect((html.match(/<title>/g) ?? [])).toHaveLength(0);
  });
});

describe("layout", () => {
  it("reserves its box, so nothing reflows when the SVG paints", () => {
    const html = render(createElement(SignalLogo, { variant: "mark", size: 20 }));
    expect(html).toContain('width="20"');
    expect(html).toContain('height="20"');
  });

  it("keeps the aspect ratio — the mark can never be stretched", () => {
    // One square viewBox, and width === height at every size. The
    // symbol is centred by the viewBox's negative min-x rather than by
    // scaling the axes independently.
    for (const size of [16, 24, 48]) {
      const html = render(createElement(SignalLogo, { variant: "mark", size }));
      expect(html).toContain('viewBox="-5.25 0 48 48"');
      expect(html).toContain(`width="${size}"`);
      expect(html).toContain(`height="${size}"`);
    }
  });

  it("accepts a className without losing its own classes", () => {
    const html = render(
      createElement(SignalLogo, { variant: "mark", size: 24, className: "shrink-0" }),
    );
    expect(html).toContain("shrink-0");
  });
});

describe("the old radial mark is gone", () => {
  it("its component file no longer exists", () => {
    expect(existsSync(path.join(process.cwd(), "src/components/brand-mark.tsx"))).toBe(
      false,
    );
  });

  it("nothing imports or renders it", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of require("node:fs").readdirSync(dir, {
        withFileTypes: true,
      })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const src = readFileSync(full, "utf8");
          if (/BrandMark|brand-mark/.test(src)) hits.push(full);
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    // This file names the old symbols in order to assert their
    // absence, so it cannot count itself as evidence of their presence.
    expect(hits.filter((h) => !h.endsWith(SELF))).toEqual([]);
  });

  it("the sunburst geometry is not rendered anywhere", () => {
    // The old mark was a dot plus eight rays. Any of its path commands
    // reappearing means a copy survived somewhere.
    const html = render(createElement(SignalLogo, { variant: "mark", size: 48 }));
    for (const oldPath of [
      "M12 3v3",
      "M3 12h3",
      "m5.6 5.6 2.1 2.1",
      "m16.3 16.3 2.1 2.1",
    ]) {
      expect(html, oldPath).not.toContain(oldPath);
    }
    expect(html).not.toContain("<circle");
  });
});

describe("the surfaces that must show it", () => {
  const SIDEBAR = code(read("src/components/sidebar.tsx"));
  const MARKETING = code(read("src/app/(marketing)/layout.tsx"));
  const MORE_SHEET = code(read("src/components/mobile-more-sheet.tsx"));

  it("the desktop sidebar — the primary application navigation", () => {
    expect(SIDEBAR).toContain("SignalLogo");
    expect(SIDEBAR).toMatch(/variant="mark"/);
    // A real text label beside it, per the dashboard requirement.
    expect(SIDEBAR).toContain(">Signal<");
  });

  it("marketing uses the full lockup", () => {
    expect(MARKETING).toMatch(/variant="lockup"/);
  });

  it("the mobile More sheet carries the compact mark", () => {
    expect(MORE_SHEET).toContain("SignalLogo");
    expect(MORE_SHEET).toMatch(/variant="mark"/);
  });

  it("every authentication surface uses the lockup", () => {
    for (const page of [
      "login",
      "signup",
      "forgot-password",
      "reset-password",
    ]) {
      const src = code(read(`src/app/(auth)/${page}/page.tsx`));
      expect(src, page).toContain("SignalLogo");
      expect(src, page).toMatch(/variant="lockup"/);
    }
  });

  it("no surface hardcodes the mark's path data", () => {
    // The whole point of one component is that the geometry lives in
    // one place.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of require("node:fs").readdirSync(dir, {
        withFileTypes: true,
      })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !full.includes("brand")) {
          if (readFileSync(full, "utf8").includes("M5.397 11.615")) {
            offenders.push(full);
          }
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(offenders).toEqual([]);
  });
});

describe("icons and metadata", () => {
  const files = [
    "src/app/icon.svg",
    "src/app/favicon.ico",
    "src/app/apple-icon.png",
    "src/app/opengraph-image.png",
    "src/app/twitter-image.png",
    "public/icon-192.png",
    "public/icon-512.png",
    "src/app/manifest.ts",
  ];

  it("every asset exists", () => {
    for (const f of files) {
      expect(existsSync(path.join(process.cwd(), f)), f).toBe(true);
    }
  });

  it("the SVG icon is the real geometry, transparent, with no white plate", () => {
    const svg = read("src/app/icon.svg");
    expect(svg).toContain(SIGNAL_LOGO_PATHS.upperRibbon);
    expect(svg).toContain(SIGNAL_LOGO_PATHS.lowerRibbon);
    // No background rectangle, and nothing painted white.
    expect(svg).not.toContain("<rect");
    expect(svg.toLowerCase()).not.toContain("#fff");
    expect(svg.toLowerCase()).not.toContain("white");
    // No generation artefacts.
    for (const banned of ["filter", "linearGradient", "radialGradient", "feGaussianBlur", "image"]) {
      expect(svg, banned).not.toContain(`<${banned}`);
    }
  });

  it("the manifest names the product correctly and uses the brand navy", () => {
    const m = read("src/app/manifest.ts");
    expect(m).toContain('short_name: "Signal"');
    expect(m).toContain("#0A2360");
    expect(m).toContain("/icon-192.png");
    expect(m).toContain("/icon-512.png");
  });

  it("no stale references to an old logo asset remain", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of require("node:fs").readdirSync(dir, {
        withFileTypes: true,
      })) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx?|json|md|css)$/.test(entry.name)) {
          const src = readFileSync(full, "utf8");
          if (
            full.endsWith(SELF) === false &&
            /logo\.(png|svg|jpg)|brand-mark\.|old-logo/.test(src)
          ) {
            offenders.push(full);
          }
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(offenders).toEqual([]);
  });
});
