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
    expect(UI).toContain('href={props.automation.href} className="btn-primary"');
    expect(PAGE).toContain("hasCampaign: automation !== null");
    expect(PAGE).toContain("/relationships/campaigns?campaign=");
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
