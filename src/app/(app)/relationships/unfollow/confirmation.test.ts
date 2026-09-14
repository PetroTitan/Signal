import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The confirmation contract for automatic unfollowing.
 *
 * These read the SOURCE rather than rendering, for the same reason the
 * follow subsystem's equivalent does: these components are wired to
 * server actions that need a Next request scope vitest does not
 * provide, and mocking that away would test the mock.
 *
 * What is asserted is the STRUCTURE that makes the guarantee hold —
 * that the only form capable of dispatching the activation exists
 * inside the dialog, and only while no terminal result has been shown.
 * That is a stronger claim than "cancel did not call the server in this
 * test", because it holds for EVERY path to cancel — button, Escape,
 * backdrop, navigation, unmount — rather than the ones a test happened
 * to exercise.
 */

const code = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const read = (rel: string) =>
  code(readFileSync(path.join(process.cwd(), rel), "utf8"));

const DIALOG = read("src/app/(app)/relationships/unfollow/_confirm-activation.tsx");
const WIZARD = read("src/app/(app)/relationships/unfollow/_unfollow-wizard.tsx");
const CONTROLS = read(
  "src/app/(app)/relationships/unfollow/[id]/_controls.tsx",
);
const ACTIONS = read("src/app/(app)/relationships/unfollow/_actions.ts");

describe("a cancelled confirmation makes ZERO server-action calls", () => {
  it("the wizard contains no form bound to the activation dispatcher", () => {
    // Break by adding `<form action={activateDispatch}>` to the wizard
    // and this fails. The activating dispatcher must reach the DOM only
    // through the dialog.
    expect(WIZARD).not.toMatch(/<form[^>]*action=\{\s*activateDispatch/);
  });

  it("the trigger is a plain button that only sets state", () => {
    // A submit inside any surrounding form would fire on Enter.
    expect(WIZARD).toMatch(/type="button"[\s\S]{0,300}setConfirming\(\{/);
    expect(WIZARD).not.toMatch(/<Submit[^>]*label="Start automatic unfollowing"/);
  });

  it("the trigger's label ends in an ellipsis — the 'opens a dialog' convention", () => {
    expect(WIZARD).toContain("Unfollow people…");
  });

  it("the dialog renders NO form at all while it is closed", () => {
    // The early return when there are no facts is what makes every
    // cancel path structurally safe: after it there is no form in the
    // tree, so there is nothing that could dispatch.
    expect(DIALOG).toMatch(
      /if \(!facts\) \{[\s\S]{0,400}<dialog ref=\{ref\} className="hidden"/,
    );
  });

  it("Cancel, Escape and the backdrop all clear the SAME state", () => {
    // One path, not three. A second, divergent handler is how one of
    // them ends up doing something slightly different.
    expect(DIALOG).toMatch(/onClick=\{onCancel\}/);
    expect(DIALOG).toMatch(/node\.addEventListener\("cancel", handle\)/);
    expect(DIALOG).toMatch(/event\.preventDefault\(\);[\s\S]{0,40}onCancel\(\)/);
  });

  it("unmounting closes the dialog rather than leaving it live", () => {
    expect(DIALOG).toMatch(/useEffect\(\(\) => \(\) => \{ ref\.current\?\.close\(\); \}, \[\]\)/);
    expect(WIZARD).toMatch(/useEffect\(\(\) => \(\) => setConfirming\(null\), \[\]\)/);
  });
});

describe("a terminal outcome removes the submit control", () => {
  it("the form is rendered only when there is NO result", () => {
    // Once an outcome is shown the dialog is a RESULT, not a prompt.
    // There is no submit control left in the tree, so the same campaign
    // cannot be started twice by pressing again.
    expect(DIALOG).toMatch(/\{result \? \([\s\S]{0,600}Close[\s\S]{0,200}\) : \(/);
    const afterResult = DIALOG.slice(DIALOG.indexOf("{result ? ("));
    const closeBranch = afterResult.slice(0, afterResult.indexOf(") : ("));
    expect(closeBranch).not.toContain("<form");
    expect(closeBranch).not.toContain("ConfirmButton");
  });
});

describe("the operator must confirm the identity AND the action", () => {
  it("both typed fields gate the submit control", () => {
    expect(DIALOG).toMatch(/const handleMatches =/);
    expect(DIALOG).toMatch(/const phraseMatches =/);
    expect(DIALOG).toMatch(/ready = handleMatches && phraseMatches/);
    expect(DIALOG).toMatch(/<ConfirmButton disabled=\{!ready\} \/>/);
  });

  it("the phrase is the sentence the brief specifies", () => {
    expect(DIALOG).toContain('const PHRASE = "start automatic unfollowing"');
    expect(DIALOG).toContain("Start automatic unfollowing");
  });

  it("THE SERVER RE-CHECKS BOTH and trusts neither", () => {
    // The dialog proves a human clicked. It proves nothing about who
    // they are or what they may do, so the action re-runs the whole
    // gate — and the handle is compared to what the SESSION actually
    // resolves to, not to what the form said the identity was.
    expect(ACTIONS).toMatch(
      /formData\.get\("confirm"\)[\s\S]{0,200}!== "start automatic unfollowing"/,
    );
    expect(ACTIONS).toMatch(/const actual = \(session\.actorHandle \?\? ""\)/);
    expect(ACTIONS).toMatch(/actual !== confirmedIdentity/);
  });

  it("activation is refused while the queue is incomplete or failed", () => {
    expect(ACTIONS).toMatch(/if \(job\.status === "failed"\)/);
    expect(ACTIONS).toMatch(/if \(!job\.sourceExhausted\)/);
    expect(ACTIONS).toMatch(/campaign\.status !== "ready" && campaign\.status !== "paused"/);
  });
});

describe("the operator is told the truth about what cannot be undone", () => {
  it("the confirmation states that unfollowing is public and irreversible", () => {
    expect(DIALOG).toMatch(/public account state/i);
    expect(DIALOG).toMatch(/may affect a real person/i);
    expect(DIALOG).toMatch(/cannot undo it/i);
  });

  it("it states that pausing and cancelling do not re-follow anyone", () => {
    expect(DIALOG).toMatch(
      /Pausing or cancelling stops future work[\s\S]{0,160}does not re-follow anyone/i,
    );
  });

  it("the estimate is labelled an estimate, in those words", () => {
    expect(DIALOG).toMatch(/Estimated \{/);
    expect(DIALOG).toMatch(/This is an estimate, not a promise/i);
  });

  it("it shows requested AND effective quota as separate figures", () => {
    expect(DIALOG).toContain("You asked for");
    expect(DIALOG).toContain("Signal will do at most");
    expect(DIALOG).toMatch(/effectiveQuotaReason/);
  });

  it("an unknown count says so rather than showing a number", () => {
    expect(DIALOG).toMatch(/Still building the list/i);
    expect(DIALOG).toMatch(/facts\.stillBuilding/);
  });

  it("a dry run is stated on the confirmation itself", () => {
    expect(DIALOG).toMatch(/Signal will go through every step and send\s+nothing to Bluesky/i);
  });
});

describe("there is NO undo-all control disguised as rollback", () => {
  it("nothing in the controls offers to re-follow", () => {
    expect(CONTROLS).not.toMatch(/undo all/i);
    expect(CONTROLS).not.toMatch(/roll ?back/i);
    expect(CONTROLS).not.toMatch(/re-?follow everyone/i);
    // And it says WHY, so the absence reads as a decision rather than
    // an oversight.
    expect(CONTROLS).toMatch(/does not re-follow anyone already unfollowed/i);
  });

  it("cancelling is confirmed, and its form exists only while confirming", () => {
    expect(CONTROLS).toMatch(/\{confirmingCancel \? \(/);
    const before = CONTROLS.slice(0, CONTROLS.indexOf("{confirmingCancel ? ("));
    expect(before).not.toMatch(/<form[^>]*action=\{cancelDispatch/);
  });

  it("'Stop this identity' stops BOTH kinds, and says so", () => {
    expect(CONTROLS).toMatch(/following and unfollowing alike/i);
    expect(ACTIONS).toMatch(
      /No follow or unfollow campaign will act as this account/i,
    );
  });
});
