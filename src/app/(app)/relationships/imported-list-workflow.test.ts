import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (relativePath: string) =>
  readFileSync(path.join(process.cwd(), relativePath), "utf8");

const UI = read("src/app/(app)/relationships/_relationship-ui.tsx");
const PAGE = read("src/app/(app)/relationships/page.tsx");

describe("the imported-list workflow", () => {
  it("presents the corpus as an imported list, not a 20-person task queue", () => {
    expect(UI).toContain('label: "Imported list"');
    expect(UI).toContain("Your imported list");
    expect(UI).toContain("you do not need to select people in groups of 20");
  });

  it("makes automation the primary action for the full list", () => {
    expect(UI).toContain("Open automatic campaign");
    expect(UI).toContain("Start automatic campaign");
    // The follow CTA keeps `btn-primary`; the class list now also
    // carries `min-h-11 inline-flex items-center` so an anchor meets
    // the 44px target size the buttons beside it already did. Asserted
    // on the PROPERTY that matters — which dispatcher it links to, and
    // that it is the primary weight — rather than on an exact class
    // string, which would fail on any responsive fix.
    expect(UI).toMatch(
      /href=\{props\.automation\.href\} className="btn-primary[^"]*"/,
    );
    // "Has a campaign" means at least one LIVE campaign on the selected
    // identity — the panel shows all of them, so the link goes to the
    // campaigns list rather than to one campaign chosen silently.
    expect(PAGE).toContain("hasCampaign: liveCampaigns.length > 0");
    expect(PAGE).toContain('"/relationships/campaigns"');
  });

  it("offers unfollowing beside it, at SECONDARY weight", () => {
    // Both are primary actions on this page, but only one of them is
    // irreversible — the visual weight should not invite it.
    expect(UI).toContain("Unfollow people…");
    expect(UI).toMatch(
      /href="\/relationships\/unfollow"\s+className="btn-secondary[^"]*"/,
    );
    expect(UI).not.toMatch(
      /href="\/relationships\/unfollow"\s+className="btn-primary/,
    );
  });

  it("keeps manual actions available but collapsed by default", () => {
    expect(UI).toContain("useState(false)");
    expect(UI).toContain('data-testid="manual-relationship-tools"');
    expect(UI).toContain("Use manual tools");
    expect(UI).toContain("limited to 20 profiles per");
    expect(UI).toMatch(/showManualControls \? \([\s\S]*manual-relationship-tools/);
  });

  it("does not hide management controls on Following or Mutual", () => {
    expect(UI).toContain(
      'const showManualControls = !isImportedList || props.manualCandidateMode;',
    );
  });

  it("clears stale selections when manual mode is closed", () => {
    expect(UI).toMatch(/if \(manualCandidateMode\) setSelected\(new Set\(\)\)/);
  });
});
