/**
 * The words the operator reads must not claim what Signal does not do.
 *
 * Two sets of files, two levels of strictness:
 *   - SURFACES (pages, labels, scheduler, marketing row): no phrase
 *     that presents a manual task as an automated action, anywhere.
 *   - REFERENCE (the capability registry and the docs): these must be
 *     able to NAME the prohibited things in order to say they are
 *     prohibited, so a hit counts only on a line that does not attribute
 *     or negate it. A naive phrase list flags exactly the honest
 *     sentences — the registry's "automated engagement is prohibited".
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|md)$/.test(entry) && !entry.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const ROOT = process.cwd();
const SURFACES = [
  ...walk(path.join(ROOT, "src/app/(app)/linkedin")),
  path.join(ROOT, "src/core/linkedin-sales/state.ts"),
  path.join(ROOT, "src/core/linkedin-sales/scheduler.server.ts"),
  path.join(ROOT, "src/app/(marketing)/page.tsx"),
];
const REFERENCE = [
  path.join(ROOT, "src/core/linkedin-sales/capabilities.ts"),
  ...walk(path.join(ROOT, "docs/linkedin-sales")),
];

/** Phrases that would misdescribe a manual task as an automated action. */
const FORBIDDEN: RegExp[] = [
  /sent automatically/i,
  /sends? (it |the message |the request )?automatically/i,
  /signal (will )?(sends?|messages?|connects?|likes?|follows?|endorses?)\b(?! nothing| no | never)/i,
  /auto(?:mated|matic)? (connection|message|inmail|like|follow|endorse|engagement|outreach)/i,
  /provider confirmed/i,
  /\bexecute\b/i,
  /safe (linkedin )?limit/i,
  /within linkedin'?s limits/i,
  /message was sent/i,
  /request was sent/i,
];

/** A line that names a forbidden thing in order to refuse or attribute it. */
const ATTRIBUTED = /\b(not|no|never|forbidden|prohibit(?:ed|s)?|refus(?:e|ed|es)|avoid|instead|rather than|must not|does not|cannot|EXECUTE on|only EXECUTE|privilege|grant)\b|^\s*\|/i;

describe("truthful vocabulary", () => {
  it("no surface says Signal sends, executes or automates a LinkedIn action", () => {
    for (const file of SURFACES) {
      const text = readFileSync(file, "utf8");
      for (const re of FORBIDDEN) {
        const m = re.exec(text);
        expect(m, `${path.relative(ROOT, file)}: "${m?.[0]}"`).toBeNull();
      }
    }
  });

  it("the registry and the docs name prohibited things only to refuse them", () => {
    const offending: string[] = [];
    for (const file of REFERENCE) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const re of FORBIDDEN) {
          if (re.test(line) && !ATTRIBUTED.test(line)) {
            offending.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
          }
        }
      });
    }
    expect(offending.join("\n")).toBe("");
  });

  it("the attribution rule is not a free pass: a bare claim in a reference file is still caught", () => {
    expect(ATTRIBUTED.test("Signal sends the connection request automatically.")).toBe(false);
    expect(FORBIDDEN.some((re) => re.test("Signal sends the connection request automatically."))).toBe(true);
  });

  it("the task card's five controls are five distinct controls with the required names", () => {
    const card = readFileSync(path.join(ROOT, "src/app/(app)/linkedin/tasks/_task-card.tsx"), "utf8");
    expect(card).toMatch(/>\s*Copy draft\s*</);
    expect(card).toMatch(/Open in LinkedIn</);
    expect(card).toMatch(/label="Mark completed"/);
    expect(card).toMatch(/label="Skip and end this person's sequence"/);
    expect(card).toMatch(/label="Add to suppression list"/);
    // "Open in LinkedIn" is an anchor to the profile; "Mark completed" is a form submit. Never one control.
    expect(card).toMatch(/<a\s+href=\{task\.profileUrl\}/);
    expect(card).toMatch(/<form action=\{confirmDispatch\}/);
    // Opening never calls the confirm action.
    const openHandler = /const opened = \(\) => startTransition\(async \(\) => \{ await (\w+)\(task\.id\); \}\);/.exec(card);
    expect(openHandler?.[1]).toBe("recordOpenedAction");
    // Completion requires the operator's own statement.
    expect(card).toMatch(/name="attest" required/);
  });

  it("the boundary notice is rendered by the section layout, so it is on every page", () => {
    const layout = readFileSync(path.join(ROOT, "src/app/(app)/linkedin/layout.tsx"), "utf8");
    expect(layout).toMatch(/<BoundaryNotice \/>/);
    const notice = readFileSync(path.join(ROOT, "src/app/(app)/linkedin/_boundary-notice.tsx"), "utf8");
    expect(notice).toMatch(/never signs in to LinkedIn/);
    expect(notice).toMatch(/Nothing is completed on your behalf/);
  });

  it("the daily target is described as a workload setting, never a LinkedIn limit", () => {
    const form = readFileSync(path.join(ROOT, "src/app/(app)/linkedin/campaigns/_campaign-form.tsx"), "utf8");
    expect(form).toMatch(/workload setting for you/);
    expect(form).toMatch(/not a LinkedIn limit/);
  });

  it("labels use the required words: Prepare, Open in LinkedIn, Copied, Operator confirmed, Manual", () => {
    const state = readFileSync(path.join(ROOT, "src/core/linkedin-sales/state.ts"), "utf8");
    expect(state).toMatch(/operator_confirmed: "Operator confirmed"/);
    expect(state).toMatch(/copied: "Draft copied \(by you\)"/);
    expect(state).toMatch(/active: "Preparing tasks"/);
    const controls = readFileSync(path.join(ROOT, "src/app/(app)/linkedin/campaigns/_campaign-controls.tsx"), "utf8");
    expect(controls).toMatch(/Start preparing tasks/);
  });
});
