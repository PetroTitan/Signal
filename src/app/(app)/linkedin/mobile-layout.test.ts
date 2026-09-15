/**
 * Class-token controls for the LinkedIn Sales surfaces: touch-target
 * floor, nothing that can widen a 320px page, tables that scroll inside
 * themselves, forms with fieldsets and legends, and announcements that
 * are not colour alone. A node test cannot measure an overflow — the
 * browser sweep in docs/linkedin-sales/02-browser-qa.md does that; this
 * keeps its fixes from being refactored away.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}
const read = (rel: string) => code(readFileSync(path.join(process.cwd(), rel), "utf8"));

const BASE = "src/app/(app)/linkedin/";
const SURFACES: [string, string][] = [
  ["layout", read(`${BASE}layout.tsx`)],
  ["subnav", read(`${BASE}_subnav.tsx`)],
  ["boundary notice", read(`${BASE}_boundary-notice.tsx`)],
  ["overview", read(`${BASE}page.tsx`)],
  ["leads page", read(`${BASE}leads/page.tsx`)],
  ["lead list form", read(`${BASE}leads/_lead-list-form.tsx`)],
  ["import form", read(`${BASE}leads/_import-form.tsx`)],
  ["sequences page", read(`${BASE}sequences/page.tsx`)],
  ["sequence form", read(`${BASE}sequences/_sequence-form.tsx`)],
  ["campaigns page", read(`${BASE}campaigns/page.tsx`)],
  ["campaign form", read(`${BASE}campaigns/_campaign-form.tsx`)],
  ["campaign controls", read(`${BASE}campaigns/_campaign-controls.tsx`)],
  ["tasks page", read(`${BASE}tasks/page.tsx`)],
  ["task card", read(`${BASE}tasks/_task-card.tsx`)],
  ["analytics page", read(`${BASE}analytics/page.tsx`)],
  ["compliance page", read(`${BASE}compliance/page.tsx`)],
];
const INTERACTIVE = SURFACES.filter(([name]) => !["layout", "boundary notice"].includes(name));

describe("every interactive target is at least 44px tall", () => {
  it("no button, submit or link-styled anchor is declared without min-h-11 or a sized button class", () => {
    for (const [name, source] of INTERACTIVE) {
      const buttons = source.match(/<button[^>]*className=\{?"[^"]*"/g) ?? [];
      for (const b of buttons) expect(`${name}: ${b}`).toMatch(/min-h-11/);
      const submits = source.match(/<Submit[^>]*className="[^"]*"/g) ?? [];
      for (const b of submits) expect(`${name}: ${b}`).toMatch(/min-h-11/);
      const links = source.match(/<(Link|a)\b[^>]*className=\{?"[^"]*"/g) ?? [];
      for (const l of links) expect(`${name}: ${l}`).toMatch(/min-h-11/);
    }
  });

  it("text inputs and selects carry the floor; textareas are taller by rows", () => {
    for (const [name, source] of INTERACTIVE) {
      const inputs = source.match(/<input[^>]*type="(text|number|date|time|file)"[^>]*className="[^"]*"/g) ?? [];
      for (const i of inputs) expect(`${name}: ${i}`).toMatch(/min-h-11/);
      const selects = source.match(/<select[^>]*className="[^"]*"/g) ?? [];
      for (const s of selects) expect(`${name}: ${s}`).toMatch(/min-h-11/);
    }
  });

  it("checkbox and radio glyphs are 20px, cannot shrink, and sit inside a 44px label row", () => {
    // The first sweep measured glyphs at 18px and 13px at 320px: a flex
    // item beside long text shrinks unless told not to.
    for (const [name, source] of INTERACTIVE) {
      const glyphs = source.match(/<input[^>]*type="(checkbox|radio)"[^>]*/g) ?? [];
      for (const g of glyphs) expect(`${name}: ${g}`).toMatch(/h-5 w-5 shrink-0/);
      if (glyphs.length > 0) expect(source, name).toMatch(/<label className="flex items-start gap-3 min-h-11/);
    }
  });
});

describe("nothing can push a row past 320px", () => {
  it("every profile URL is rendered with break-all", () => {
    const card = read(`${BASE}tasks/_task-card.tsx`);
    expect(card).toMatch(/break-all">\{task\.profileUrl\}/);
    const leads = read(`${BASE}leads/page.tsx`);
    expect(leads).toMatch(/break-all">\{lead\.canonical_profile_url\}/);
  });

  it("every table scrolls inside its own container and declares a minimum width, not a fixed one", () => {
    for (const [name, source] of SURFACES) {
      const tables = source.match(/<table/g)?.length ?? 0;
      const wrappers = source.match(/overflow-x-auto">\s*<table/g)?.length ?? 0;
      expect(wrappers, `${name}: every table wrapped`).toBe(tables);
      expect(source, name).not.toMatch(/\bw-\[\d+px\]/);
    }
  });

  it("the sub-navigation scrolls inside itself rather than wrapping the page", () => {
    const nav = read(`${BASE}_subnav.tsx`);
    expect(nav).toMatch(/overflow-x-auto/);
    expect(nav).toMatch(/min-w-max/);
  });

  it("the cancel dialog is viewport-relative and scrolls itself", () => {
    const dialog = read(`${BASE}campaigns/_campaign-controls.tsx`);
    expect(dialog).toMatch(/w-\[calc\(100vw-2rem\)\]/);
    expect(dialog).toMatch(/max-h-\[90vh\] overflow-y-auto/);
    expect(dialog).toMatch(/showModal\(\)/);
  });

  it("button rows stack below sm, and no grid has more than two columns before the sm breakpoint", () => {
    for (const [name, source] of INTERACTIVE) {
      const rows = source.match(/flex flex-col sm:flex-row flex-wrap gap-2/g)?.length ?? 0;
      const fullWidth = source.match(/w-full sm:w-auto/g)?.length ?? 0;
      if (/<button/.test(source)) expect(rows + fullWidth, `${name}: stacking`).toBeGreaterThan(0);
      // A base (un-prefixed) grid-cols-3 or wider is what squeezes 320px.
      const wide = source.match(/(?<![:\w-])grid-cols-(?:[3-9]|\d{2})\b/g) ?? [];
      expect(wide, `${name}: base grid too wide`).toEqual([]);
    }
  });
});

describe("semantics and announcements", () => {
  it("forms with grouped choices use fieldset and legend", () => {
    for (const name of ["leads/_lead-list-form.tsx", "leads/_import-form.tsx", "campaigns/_campaign-form.tsx", "sequences/_sequence-form.tsx"]) {
      const src = read(`${BASE}${name}`);
      expect(src, name).toMatch(/<fieldset/);
      expect(src, name).toMatch(/<legend/);
    }
  });

  it("results are announced (role=status / role=alert / aria-live), never colour alone", () => {
    for (const [name, source] of INTERACTIVE) {
      if (/useFormState/.test(source)) {
        expect(source, name).toMatch(/role="alert"/);
        expect(source, name).toMatch(/role="status"/);
      }
    }
    expect(read(`${BASE}tasks/_task-card.tsx`)).toMatch(/aria-live="polite"/);
  });

  it("the current section is announced with aria-current and shown with weight and an underline", () => {
    const nav = read(`${BASE}_subnav.tsx`);
    expect(nav).toMatch(/aria-current=\{current \? "page" : undefined\}/);
    expect(nav).toMatch(/font-semibold/);
    expect(nav).toMatch(/border-b-2/);
    expect(nav).toMatch(/aria-label="LinkedIn Sales sections"/);
  });

  it("the new-tab link says so to a screen reader and uses rel=noopener", () => {
    const card = read(`${BASE}tasks/_task-card.tsx`);
    expect(card).toMatch(/target="_blank"\s+rel="noopener noreferrer"/);
    expect(card).toMatch(/sr-only"> \(opens the public profile in a new tab\)/);
  });

  it("every page section has a labelled heading", () => {
    for (const name of ["page.tsx", "leads/page.tsx", "sequences/page.tsx", "campaigns/page.tsx", "tasks/page.tsx", "analytics/page.tsx", "compliance/page.tsx"]) {
      const src = read(`${BASE}${name}`);
      const sections = src.match(/<section aria-labelledby="([a-z-]+)"/g) ?? [];
      expect(sections.length, name).toBeGreaterThan(0);
      for (const s of sections) {
        const id = /aria-labelledby="([a-z-]+)"/.exec(s)![1];
        expect(src, `${name}: #${id}`).toContain(`id="${id}"`);
      }
    }
  });
});
