import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StrategyHints, type StrategyHint } from "./strategy-hints";

const HINTS: StrategyHint[] = [
  {
    id: "explore-hook-question",
    title: "Try a question-led opening",
    rationale: "None of your last 28 posts opens with a question.",
  },
  {
    id: "differentiate-bluesky",
    title: "A different angle for Bluesky",
    rationale: "Your last cross-platform pair shared 31% of its wording.",
  },
];

const markup = renderToStaticMarkup(createElement(StrategyHints, { hints: HINTS }));

describe("the advisory strip beside publishing controls", () => {
  it("shows each hint with its reason", () => {
    for (const hint of HINTS) {
      expect(markup).toContain(hint.title);
      expect(markup).toContain(hint.rationale);
    }
  });

  it("renders no control of any kind", () => {
    // The strip sits next to approve and schedule. A button here could
    // be mistaken for part of that flow.
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("disabled");
    expect(markup).not.toContain("checkbox");
  });

  it("uses no severity colouring", () => {
    for (const severity of ["badge-high", "badge-medium", "text-red", "bg-red", "border-red"]) {
      expect(markup).not.toContain(severity);
    }
  });

  it("says in words that ignoring it changes nothing", () => {
    expect(markup).toContain("Nothing here is required");
    expect(markup).toContain("changes nothing about");
  });

  it("links to the evidence rather than asserting it", () => {
    expect(markup).toContain('href="/strategy"');
  });

  it("renders nothing at all when there is nothing to say", () => {
    // An empty box reading "no recommendations" would itself be a
    // finding, and a false one.
    expect(renderToStaticMarkup(createElement(StrategyHints, { hints: [] }))).toBe("");
  });
});

describe("the surfaces that host it stay unblocked", () => {
  const plan = readFileSync(
    path.join(process.cwd(), "src/app/(app)/weekly-plan/page.tsx"),
    "utf8",
  );
  const sheet = readFileSync(
    path.join(process.cwd(), "src/components/founder-compose/founder-compose-sheet.tsx"),
    "utf8",
  );

  it("renders the strip on the weekly plan", () => {
    expect(plan).toContain("<StrategyHints hints={strategyHints} />");
  });

  it("renders the strip in the composer without gating anything on it", () => {
    expect(sheet).toContain("<StrategyHints");
    // No approval, submit or disabled state may reference the hints.
    const gated = sheet.match(/strategyHints[^\n]*(disabled|required|canSubmit|blocked)/);
    expect(gated).toBeNull();
  });

  it("keeps the hints optional in the compose contract", () => {
    expect(sheet).toContain("strategyHints?: StrategyHint[]");
  });

  it("never lets an advisory read break a publishing surface", () => {
    const loader = readFileSync(
      path.join(process.cwd(), "src/core/strategy/load-strategy-hints.server.ts"),
      "utf8",
    );
    expect(loader).toContain("catch");
    expect(loader).toContain("return [];");
  });
});
