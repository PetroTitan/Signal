import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Contracts for the confirmation step.
 *
 * These read the source rather than rendering, for the same reason the
 * authorization tests do: these components are wired to server actions
 * that need a Next request scope vitest does not provide, and mocking
 * that away would test the mock.
 *
 * What is asserted is the STRUCTURE that makes the guarantee hold —
 * specifically that the only form capable of dispatching these actions
 * exists inside the dialog. That is a stronger claim than "cancel does
 * not call the server", because it holds for every path to cancel
 * (button, Escape, backdrop, unmount) rather than the ones a test
 * happened to exercise.
 */

const code = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const read = (rel: string) =>
  code(readFileSync(path.join(process.cwd(), rel), "utf8"));

const UI = read("src/app/(app)/relationships/_relationship-ui.tsx");
const DIALOG = read("src/app/(app)/relationships/_confirm-dialog.tsx");

describe("no irreversible action executes on the first click", () => {
  it("the list surface contains NO form bound to a mutating action", () => {
    // Break by restoring `<form action={props.runFollow}>` and this
    // fails. The mutating dispatchers must reach the DOM only through
    // the dialog.
    for (const dispatcher of ["runFollow", "runUnfollow", "runRemove"]) {
      expect(
        UI,
        `_relationship-ui.tsx must not bind ${dispatcher} to a form`,
      ).not.toMatch(new RegExp(`<form[^>]*action=\\\\{\\\\s*props\\\\.${dispatcher}`));
      expect(UI).not.toMatch(new RegExp(`<form[^>]*action=\\\\{\\\\s*${dispatcher}`));
    }
  });

  it("Follow, Unfollow and Remove triggers are type=button, not submits", () => {
    // A submit inside any surrounding form would fire on Enter.
    const triggers = UI.match(/onClick=\{\(\) =>\s*props\.onConfirm/g) ?? [];
    // batch follow, batch unfollow, row follow, row unfollow, remove target
    expect(triggers.length).toBeGreaterThanOrEqual(4);
    expect(UI).toMatch(/type="button"[\s\S]{0,400}onConfirm/);
    expect(UI).not.toMatch(/<SubmitButton[^>]*>\s*Follow selected/);
    expect(UI).not.toMatch(/<SubmitButton[^>]*>\s*Unfollow selected/);
  });

  it("their labels end in an ellipsis, the convention for 'opens a dialog'", () => {
    for (const label of [
      "Follow selected…",
      "Unfollow selected…",
      "Follow…",
      "Unfollow…",
      "Remove…",
    ]) {
      expect(UI, `missing trigger label: ${label}`).toContain(label);
    }
  });

  it("a single-account action uses the same confirmation path as a batch", () => {
    // Same builder, same dialog, same dispatchers — one row is still a
    // public, irreversible change to someone else's feed.
    expect(UI).toMatch(/request\("follow", \[candidate\.id\]\)/);
    expect(UI).toMatch(/request\("unfollow", \[candidate\.id\]\)/);
    expect(UI).toMatch(/request\("follow", props\.selectedIds\)/);
    expect(UI).toMatch(/request\("unfollow", props\.selectedIds\)/);
  });
});

describe("cancel cannot reach the server", () => {
  it("the only mutating form lives inside the dialog", () => {
    const forms = DIALOG.match(/<form[^>]*action=\{[^}]*\}/g) ?? [];
    expect(forms).toHaveLength(1);
    expect(forms[0]).toContain("props.dispatch");
  });

  it("the dialog renders no form at all when nothing is being confirmed", () => {
    // `if (!request) return <dialog … />` with no children: there is
    // literally no form in the tree to submit.
    expect(DIALOG).toMatch(
      /if \(!request\) \{[\s\S]{0,400}return <dialog[\s\S]{0,200}\/>;/,
    );
  });

  it("Cancel is a plain button that only clears state", () => {
    expect(DIALOG).toMatch(/type="button"[\s\S]{0,160}onClick=\{onCancel\}/);
    // It is not inside the dispatching form.
    const cancelAt = DIALOG.indexOf("onClick={onCancel}");
    const formAt = DIALOG.indexOf("<form action={props.dispatch}");
    expect(cancelAt).toBeGreaterThan(-1);
    expect(formAt).toBeGreaterThan(cancelAt);
  });

  it("Escape and the backdrop route through the same onCancel, not a second path", () => {
    // A divergent dismiss path is how "cancel does nothing" quietly
    // stops being true for one of the three ways to dismiss.
    expect(DIALOG).toMatch(/addEventListener\("cancel"/);
    expect(DIALOG).toMatch(/event\.preventDefault\(\)[\s\S]{0,60}onCancel\(\)/);
  });

  it("no effect or timer can dispatch on its own", () => {
    expect(DIALOG).not.toMatch(/setTimeout|setInterval/);
    expect(DIALOG).not.toMatch(/useEffect\([\s\S]{0,200}dispatch\(/);
  });
});

describe("the dialog states what is about to happen", () => {
  it("names the actor identity", () => {
    expect(DIALOG).toContain("Acting as");
    expect(DIALOG).toContain("request.actorLabel");
  });

  it("states the count in the heading", () => {
    expect(DIALOG).toMatch(/Follow \$\{n\} accounts\?/);
    expect(DIALOG).toMatch(/Unfollow \$\{n\} accounts\?/);
    // Singular is not "1 accounts".
    expect(DIALOG).toMatch(/n === 1 \? "Follow 1 account\?"/);
  });

  it("states the external, irreversible effect for each action", () => {
    expect(DIALOG).toContain("creates a public follow on Bluesky");
    expect(DIALOG).toContain("The accounts will be notified");
    expect(DIALOG).toContain("Signal cannot undo it");
    // Removing a target is NOT a relationship change, and says so —
    // overstating it would train operators to ignore the dialog.
    expect(DIALOG).toContain("no relationship on Bluesky changes");
  });

  it("states protected exclusions before the operator confirms", () => {
    expect(DIALOG).toContain("request.protectedExcluded");
    expect(DIALOG).toContain("excluded and will not be unfollowed");
  });

  it("lists what will be acted on, with an overflow count rather than a wall", () => {
    expect(DIALOG).toMatch(/slice\(0, 5\)/);
    expect(DIALOG).toMatch(/and \{overflow\} more/);
  });

  it("the builder excludes protected accounts from an unfollow payload", () => {
    // The dialog's count and the posted fields agree, so the operator
    // confirms exactly what will be attempted.
    expect(UI).toMatch(
      /kind === "unfollow"[\s\S]{0,200}filter\([\s\S]{0,120}\.protected\)/,
    );
  });
});

describe("accessibility", () => {
  it("uses a native modal dialog, which brings the focus trap with it", () => {
    expect(DIALOG).toContain("showModal()");
    expect(DIALOG).toContain("<dialog");
  });

  it("is labelled and described, so it is not announced as just 'dialog'", () => {
    expect(DIALOG).toContain('aria-labelledby="confirm-title"');
    expect(DIALOG).toContain('aria-describedby="confirm-effect"');
    expect(DIALOG).toContain('id="confirm-title"');
    expect(DIALOG).toContain('id="confirm-effect"');
  });

  it("closes through the element's own close(), keeping state and DOM in step", () => {
    expect(DIALOG).toMatch(/node\.close\(\)/);
  });
});

describe("confirmation is not authorization", () => {
  it("every confirmed action still runs the full server gate", () => {
    const actions = read("src/app/(app)/relationships/_actions.ts");
    // Nothing about the dialog weakens what the server does. A
    // `confirmed` flag in the payload would be the client asserting its
    // own authorization, which is exactly what must not happen.
    expect(actions).not.toMatch(/formData\.get\(\s*["']confirmed["']/);
    expect(actions).not.toMatch(/skipAuth|trustClient|preconfirmed/i);
    expect(actions).toContain("requireRelationshipContext");
    expect(actions).toContain("checkBatchSize(candidateIds.length)");
  });
});
