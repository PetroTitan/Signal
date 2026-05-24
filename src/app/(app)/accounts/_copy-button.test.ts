/**
 * CopyButton tests — the "no empty button rendering" contract.
 *
 * Renders the component via renderToStaticMarkup to confirm:
 *   - returns null for null / empty / whitespace-only values
 *   - renders a real button for any non-trivial value
 *   - exposes a stable test selector + data-state for the test
 *     environment to interrogate
 */

import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyButton } from "./_copy-button";

function render(props: { value: string | null; label?: string }): string {
  return renderToStaticMarkup(
    React.createElement(CopyButton, {
      value: props.value,
      label: props.label ?? "body",
    }),
  );
}

describe("CopyButton — conditional render", () => {
  it("renders nothing when value is null", () => {
    expect(render({ value: null })).toBe("");
  });

  it("renders nothing when value is an empty string", () => {
    expect(render({ value: "" })).toBe("");
  });

  it("renders nothing when value is whitespace-only", () => {
    expect(render({ value: "   \n\t  " })).toBe("");
  });

  it("renders a button with the provided label when value is non-empty", () => {
    const html = render({ value: "real content", label: "body" });
    expect(html).toContain("button");
    expect(html).toContain("Copy body");
    expect(html).toContain('data-testid="copy-button"');
    expect(html).toContain('data-state="idle"');
  });

  it("button uses the label in the accessible name (aria-label)", () => {
    const html = render({ value: "x", label: "CTA" });
    expect(html).toContain('aria-label="Copy cta"');
  });
});
