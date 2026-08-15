import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * UI contracts that a browser would catch and a unit test would not.
 *
 * Two defect classes motivate this file, both of which shipped and
 * survived 3200 passing tests:
 *
 *   1. `btn-secondary` was referenced by 31 call sites and defined
 *      nowhere. Tailwind emits nothing for an unknown class, so those
 *      controls rendered as bare body text — including a full-width
 *      "Approve & hold" approval button and eight account-disconnect
 *      buttons. Nothing in the repo read globals.css.
 *
 *   2. Three components used `env(safe-area-inset-bottom)` while the
 *      app never declared `viewport-fit=cover`, so per the CSS Env spec
 *      every one of them resolved to 0px. Dead code that looked live.
 *
 * These are class-token proxies, not layout measurements: they assert
 * that a fix is present, not that no element overflows. That is the
 * honest limit of a node-environment test, and it is still enough to
 * make both defect classes unrepresentable.
 */

const REPO_ROOT = process.cwd();
const SRC_ROOT = path.join(REPO_ROOT, "src");
const GLOBALS_CSS = path.join(SRC_ROOT, "app", "globals.css");

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const ALL_FILES = walk(SRC_ROOT);
const COMPONENT_FILES = ALL_FILES.filter((f) => !/\.test\.tsx?$/.test(f));

function rel(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

describe("guard the guard", () => {
  it("walked a meaningful number of source files", () => {
    expect(COMPONENT_FILES.length).toBeGreaterThan(200);
  });
});

// =====================================================================
// 1. No phantom design-system classes
// =====================================================================

/** Every class defined in the `@layer components` block. */
function definedComponentClasses(): Set<string> {
  const css = fs.readFileSync(GLOBALS_CSS, "utf8");
  const layerStart = css.indexOf("@layer components");
  expect(layerStart, "@layer components block not found").toBeGreaterThan(-1);
  const layer = css.slice(layerStart);
  const names = new Set<string>();
  for (const match of layer.matchAll(/^\s{2}\.([a-z0-9-]+)/gm)) {
    names.add(match[1]!);
  }
  // Classes composed via @apply inside the layer count as defined too.
  return names;
}

/**
 * Tokens that look like design-system classes. Deliberately narrow: a
 * broad match would sweep in Tailwind utilities (`border-ink-200`,
 * `card` is ours but `cursor-pointer` is not), and a guard that has to
 * carry a large exception list stops being trustworthy.
 */
const DS_PREFIXES =
  /^(btn|badge|card|input|stat-label|stat-value|section-title|row-divider|nav-link|nav-item-active)(-[a-z0-9-]+)?$/;

describe("design-system classes referenced in components are defined", () => {
  const defined = definedComponentClasses();

  it("globals.css defines the classes we expect it to", () => {
    // Guards the parser: if the regex stops matching, everything below
    // passes vacuously.
    for (const name of ["btn", "btn-primary", "btn-secondary", "card", "input"]) {
      expect(defined.has(name), `${name} should be defined`).toBe(true);
    }
    expect(defined.size).toBeGreaterThan(10);
  });

  it("no component references an undefined design-system class", () => {
    const violations: string[] = [];
    for (const file of COMPONENT_FILES) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /className=(?:"([^"]*)"|\{`([^`]*)`\})/g,
      )) {
        const value = match[1] ?? match[2] ?? "";
        for (const token of value.split(/[\s`${}]+/)) {
          const bare = token.replace(/^(hover|focus|md|sm|lg|disabled):/, "");
          if (!DS_PREFIXES.test(bare)) continue;
          if (defined.has(bare)) continue;
          violations.push(`${rel(file)} → "${bare}"`);
        }
      }
    }
    const detail = [...new Set(violations)].join("\n");
    expect(
      detail,
      "these classes are referenced but emit no CSS, so the control " +
        "renders as bare Preflight-stripped text",
    ).toBe("");
  });
});

// =====================================================================
// 2. Safe-area handling is actually live
// =====================================================================

describe("safe-area insets resolve to real values", () => {
  it("the root layout declares viewport-fit: cover", () => {
    const layout = fs.readFileSync(
      path.join(SRC_ROOT, "app", "layout.tsx"),
      "utf8",
    );
    expect(layout).toMatch(/export const viewport/);
    expect(layout).toMatch(/viewportFit:\s*"cover"/);
  });

  it("every file using env(safe-area-inset) is covered by that declaration", () => {
    // The declaration is global, so this is really an existence check —
    // but it fails loudly if someone removes the viewport export while
    // safe-area usages remain, which is the regression that produced
    // three dead usages in the first place.
    const users = COMPONENT_FILES.filter((f) =>
      fs.readFileSync(f, "utf8").includes("env(safe-area-inset"),
    );
    expect(users.length).toBeGreaterThan(0);
    const layout = fs.readFileSync(
      path.join(SRC_ROOT, "app", "layout.tsx"),
      "utf8",
    );
    expect(layout).toContain("viewportFit");
  });
});

// =====================================================================
// 3. The mobile primary navigation is reachable
// =====================================================================

describe("mobile navigation", () => {
  const nav = fs.readFileSync(
    path.join(SRC_ROOT, "components", "mobile-nav.tsx"),
    "utf8",
  );

  it("is pinned rather than sitting at the end of the document", () => {
    expect(nav).toMatch(/\bfixed\b/);
    expect(nav).toMatch(/\bbottom-0\b/);
    expect(nav).toMatch(/\bz-\d+\b/);
  });

  it("respects the home-indicator inset", () => {
    expect(nav).toContain("env(safe-area-inset-bottom)");
  });

  it("meets the 44px touch-target floor", () => {
    expect(nav).toContain("min-h-[44px]");
  });

  it("announces the current page and labels the landmark", () => {
    expect(nav).toContain('aria-label="Primary"');
    expect(nav).toContain("aria-current");
  });

  it("the shell reserves space so content is not parked under it", () => {
    const shell = fs.readFileSync(
      path.join(SRC_ROOT, "components", "signal-shell.tsx"),
      "utf8",
    );
    expect(shell).toMatch(/pb-\[calc\(/);
    expect(shell).toContain("safe-area-inset-bottom");
  });
});

describe("sidebar navigation", () => {
  const sidebar = fs.readFileSync(
    path.join(SRC_ROOT, "components", "sidebar.tsx"),
    "utf8",
  );

  it("labels its landmark, so two navs are distinguishable to a screen reader", () => {
    expect(sidebar).toContain('aria-label="Primary"');
  });

  it("announces the current page rather than signalling it visually only", () => {
    expect(sidebar.match(/aria-current=/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("uses the shared blue active treatment", () => {
    expect(sidebar).toContain("nav-item-active");
    expect(sidebar).not.toContain('"bg-ink-100 text-ink-900 font-medium"');
  });
});

// =====================================================================
// 4. Focus indicators meet WCAG 1.4.11 (3:1)
// =====================================================================

describe("focus indicators", () => {
  const css = fs.readFileSync(GLOBALS_CSS, "utf8");

  it("does not use signal-300 as a focus ring (2.57:1 on white)", () => {
    expect(css).not.toContain("focus:ring-signal-300");
  });

  it("does not composite the global ring below full opacity", () => {
    // signal-500 at 45% composites to rgb(154 180 238) over white,
    // which is 2.07:1.
    expect(css).not.toMatch(/--shadow-focus:.*signal-500\)\s*\/\s*0\./);
  });

  it("the global focus ring uses full-strength signal-500", () => {
    expect(css).toMatch(/--shadow-focus:[^;]*rgb\(var\(--signal-500\)\)/);
  });
});

// =====================================================================
// 5. Editor overflow containment
// =====================================================================

describe("the compose editor cannot pan horizontally", () => {
  const sheet = fs.readFileSync(
    path.join(SRC_ROOT, "components", "founder-compose", "founder-compose-sheet.tsx"),
    "utf8",
  );

  it("has no unqualified max-w-xs inside the overflow-hidden sheet", () => {
    // max-w-xs is 320px; the sheet root is overflow-hidden, so at
    // <=352px the approval-failure reason was clipped entirely.
    // A breakpoint-qualified `sm:max-w-xs` is fine — the cap only
    // applies once there is room for it — so this tokenizes rather
    // than substring-matching.
    const unqualified: string[] = [];
    for (const match of sheet.matchAll(
      /className=(?:"([^"]*)"|\{`([^`]*)`\})/g,
    )) {
      const value = match[1] ?? match[2] ?? "";
      for (const token of value.split(/[\s`${}]+/)) {
        if (token === "max-w-xs" || token === "max-w-sm") {
          unqualified.push(token);
        }
      }
    }
    expect(unqualified).toEqual([]);
  });

  it("the footer row can reflow", () => {
    const footerStart = sheet.indexOf("function ComposeFooter");
    expect(footerStart).toBeGreaterThan(-1);
    const footer = sheet.slice(footerStart);
    expect(footer).toMatch(/flex items-center justify-between gap-2 flex-wrap/);
  });

  it("the preview tab strip can scroll instead of widening the body", () => {
    const tabs = fs.readFileSync(
      path.join(SRC_ROOT, "components", "platform-preview", "PreviewTabs.tsx"),
      "utf8",
    );
    expect(tabs).toContain("overflow-x-auto");
  });

  it("shape-summary rows cannot be widened by a long URL", () => {
    const summary = fs.readFileSync(
      path.join(
        SRC_ROOT,
        "components",
        "platform-native",
        "platform-shape-summary.tsx",
      ),
      "utf8",
    );
    // `1fr` is minmax(auto,1fr) and carries a min-content floor;
    // minmax(0,1fr) does not.
    expect(summary).not.toMatch(/grid-cols-\[110px_1fr\]/);
    expect(summary).toMatch(/minmax\(0,1fr\)/);
  });
});

// =====================================================================
// 6. No fixed element without a resolved vertical anchor
// =====================================================================

describe("fixed positioning", () => {
  it("no fixed element relies on top:auto", () => {
    // A fixed box with top:auto takes its static position relative to
    // the VIEWPORT — it renders in place and then detaches on scroll.
    // The reschedule popover did exactly this.
    const violations: string[] = [];
    for (const file of COMPONENT_FILES) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /className=(?:"([^"]*)"|\{`([^`]*)`\})/g,
      )) {
        const value = match[1] ?? match[2] ?? "";
        const tokens = value.split(/[\s`${}]+/);
        if (!tokens.includes("fixed")) continue;
        const anchored = tokens.some((t) =>
          /^(inset-0|inset-y-|top-|bottom-)/.test(t),
        );
        // An inline `style` supplying bottom/top counts as anchored;
        // the FAB does this to compose the safe-area inset.
        const near = source.slice(Math.max(0, match.index! - 400), match.index!);
        const styled = /style=\{\{[\s\S]*?(bottom|top):/.test(near);
        if (!anchored && !styled) {
          const line = source.slice(0, match.index).split("\n").length;
          violations.push(`${rel(file)}:${line}`);
        }
      }
    }
    expect(violations.join("\n")).toBe("");
  });
});
