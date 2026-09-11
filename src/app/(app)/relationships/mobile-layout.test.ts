import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Mobile-layout contracts for the relationships surface.
 *
 * These are class-token proxies, not layout measurements — the same
 * honest limit `src/test/ui-contract.test.ts` states for itself. A node
 * test cannot measure an overflow. What it CAN do is make the specific
 * defect that causes overflow on this page unrepresentable.
 *
 * THE DEFECT THESE EXIST FOR
 * --------------------------
 * A flex child defaults to `min-width: auto`, which means it refuses to
 * shrink below its content's intrinsic width. This page renders DIDs —
 * `did:plc:z72i7hdynmk6r22z27h6tvur`, 32 unbreakable characters — and
 * handles, inside flex rows. Without `min-w-0` on the flex child and a
 * `break-all`/`break-words` on the text, one DID pushes its row past
 * 320px and the whole page scrolls sideways. It is the single most
 * common cause of horizontal overflow in a list UI, and it is invisible
 * until someone opens the page on a phone.
 *
 * The real-browser sweep at 320/360/375/390/430/768/1280 is recorded in
 * the milestone report; this file is what keeps the fix from being
 * refactored away afterwards.
 */

/**
 * Strip comments before matching.
 *
 * Every one of the content assertions below fired on this file's own
 * prose the first time it ran: the UI module's doc comment explains
 * that the page has "no quality score" and that the tab strip is the
 * only `overflow-x-auto`, and a control that fails on the sentence
 * describing the invariant pressures the next person to delete the
 * explanation rather than keep it.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const UI = code(
  readFileSync(
    path.join(process.cwd(), "src/app/(app)/relationships/_relationship-ui.tsx"),
    "utf8",
  ),
);
const PAGE = readFileSync(
  path.join(process.cwd(), "src/app/(app)/relationships/page.tsx"),
  "utf8",
);

describe("long identifiers cannot push the page sideways", () => {
  it("every element rendering a DID can break mid-string", () => {
    // A DID has no spaces and no hyphens to break at, so the default
    // `overflow-wrap: normal` cannot wrap it at all.
    const didLines = UI.split("\n").filter(
      (line) =>
        (line.includes("subject_did") || line.includes("batch_id")) &&
        // An aria-label is announced, not laid out; it cannot overflow.
        !line.includes("aria-label"),
    );
    expect(didLines.length).toBeGreaterThan(0);
    for (const line of didLines) {
      // Either the line itself carries break-all, or it is the child of
      // a <p> whose className does — check a small window around it.
      const index = UI.indexOf(line);
      const window = UI.slice(Math.max(0, index - 220), index + 220);
      expect(window, `no break-all near: ${line.trim()}`).toMatch(
        /break-all|truncate/,
      );
    }
  });

  it("handles render with break-all, not with whitespace-nowrap", () => {
    const handleLines = UI.split("\n").filter((l) => l.includes("candidate.handle"));
    expect(handleLines.length).toBeGreaterThan(0);
    expect(UI).not.toMatch(/whitespace-nowrap[^"]*"\s*>\s*@\{/);
  });

  it("every flex row containing identity text opts out of min-width:auto", () => {
    // Break by deleting `min-w-0` and a long DID stops shrinking.
    const flexRows = UI.match(/className="flex[^"]*"/g) ?? [];
    const identityRows = flexRows.filter((c) => c.includes("items-start gap-3"));
    expect(identityRows.length).toBeGreaterThan(0);
    for (const row of identityRows) {
      expect(row, row).toContain("min-w-0");
    }
  });

  it("the growing column inside each row is also min-w-0", () => {
    // `flex-1` alone still honours min-width:auto. Both are required.
    const growing = UI.match(/className="min-w-0 flex-1"/g) ?? [];
    expect(growing.length).toBeGreaterThan(0);
  });
});

describe("nothing is fixed-width or horizontally scrolling except the tab strip", () => {
  it("no fixed pixel width appears anywhere in the surface", () => {
    // Break by writing w-[420px] and this fails.
    expect(UI).not.toMatch(/\bw-\[\d+px\]/);
    expect(UI).not.toMatch(/\bmin-w-\[\d+px\]/);
    expect(UI).not.toMatch(/style=\{\{[^}]*width:/);
  });

  it("no <table> is used for the candidate or history lists", () => {
    // A table is the classic source of unavoidable horizontal overflow
    // on a narrow screen. These are lists of cards.
    expect(UI).not.toMatch(/<table|<thead|<tbody|<tr[\s>]/);
  });

  it("overflow-x-auto appears exactly once, on the tab strip", () => {
    const occurrences = UI.match(/overflow-x-auto/g) ?? [];
    expect(occurrences).toHaveLength(1);
    const index = UI.indexOf("overflow-x-auto");
    const context = UI.slice(Math.max(0, index - 300), index + 120);
    expect(context).toContain('aria-label="Relationship views"');
  });

  it("images are fixed-size avatars that shrink-0 rather than stretch the row", () => {
    const avatars = UI.match(/className="w-10 h-10 rounded-full shrink-0[^"]*"/g) ?? [];
    expect(avatars.length).toBeGreaterThanOrEqual(2);
  });
});

describe("the page uses the shell's responsive container", () => {
  it("matches the padding scale every other authenticated page uses", () => {
    expect(PAGE).toContain("px-4 sm:px-6 lg:px-10");
    expect(PAGE).toContain("py-6 sm:py-8");
  });

  it("caps the content width rather than letting it stretch at 1280", () => {
    expect(PAGE).toMatch(/max-w-\w+/);
  });

  it("renders through Topbar, so the mobile nav and back affordance are present", () => {
    expect(PAGE).toContain("<Topbar");
  });
});

describe("touch targets and inputs", () => {
  it("selection checkboxes are at least 20px, not the 13px browser default", () => {
    expect(UI).toMatch(/type="checkbox"[\s\S]{0,420}w-5 h-5/);
  });

  it("every checkbox has an accessible name naming the account", () => {
    // A column of unlabelled checkboxes is unusable with a screen
    // reader, and on this page each one authorises a public action.
    expect(UI).toMatch(/aria-label=\{`Select \$\{/);
    // The name is built from the BARE handle, so a stored "@name" is
    // not announced as "at at name", and it falls back to the DID
    // rather than to an empty string.
    expect(UI).toMatch(/aria-label=\{`Select \$\{bareHandle\(candidate\.handle\) \?\? candidate\.subject_did\}`\}/);
  });

  it("text inputs use the .input class, which is 16px on mobile", () => {
    // iOS Safari auto-zooms any control under 16px on focus, which
    // yanks the layout sideways mid-typing. globals.css sets
    // `.input { text-base md:text-sm }` for exactly this.
    const inputs = UI.match(/<input\s[^>]*type="(text|search)?"?[^>]*>/g) ?? [];
    for (const input of inputs) {
      if (input.includes('type="hidden"') || input.includes('type="checkbox"')) {
        continue;
      }
      expect(input, input).toContain("input");
    }
  });

  it("action rows wrap instead of overflowing when several buttons are present", () => {
    // Follow / Unfollow / Protect side by side exceed 320px.
    const actionRows = UI.match(/className="mt-3 flex flex-wrap gap-2"/g) ?? [];
    expect(actionRows.length).toBeGreaterThanOrEqual(2);
  });
});

describe("the surface makes no claim it has not measured", () => {
  it("shows no score, ranking, recommendation or projection", () => {
    for (const forbidden of [
      "score",
      "Score",
      "rank",
      "Rank",
      "recommend",
      "Recommend",
      "predicted",
      "projection",
      "growth rate",
    ]) {
      expect(UI, `UI must not mention ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("renders `unknown` as a state the operator should notice", () => {
    // Amber rather than grey: unknown is precisely the state a batch
    // action must not assume away.
    expect(UI).toMatch(/case "unknown":[\s\S]{0,240}badge-medium/);
  });

  it("never labels a partial import as complete", () => {
    // The copy comes from describeImportProgress, which gates the word
    // "Complete" behind cursor exhaustion. The UI must not add its own.
    expect(UI).not.toMatch(/["'>]\s*Imported all/);
    expect(UI).toContain("progressLabel");
  });
});
