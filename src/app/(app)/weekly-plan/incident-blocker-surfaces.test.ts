import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The approve/reject CTAs use react-dom's form hooks, which do not
// exist in the node SSR environment. Stubbing them lets the guidance
// copy — the thing this incident was about — be asserted on real
// rendered markup rather than on source text. `react-dom/server` is a
// separate module and is untouched.
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useFormState: (_action: unknown, initial: unknown) => [initial, () => {}],
    useFormStatus: () => ({ pending: false }),
  };
});

import {
  CreativeApprovalControls,
  toCreativeStatusToken,
} from "./_creative-approval-controls";
import { deriveComposeActionState } from "@/components/founder-compose/compose-action-state";
import { friendlyFailure } from "@/core/publishing/founder-error";

const REPO_ROOT = process.cwd();

/**
 * The surfaces that told the operator the wrong thing.
 *
 * The pure evaluator is covered by publish-blockers.test.ts. This file
 * asserts what the operator actually SEES — which is where the incident
 * lived. A correct evaluator that no surface consults would have
 * changed nothing about the production card.
 */

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function renderControls(
  creativeStatus: string | null,
  postStatus: string,
  over: { hasAsset?: boolean; hasAltText?: boolean } = {},
): string {
  return renderToStaticMarkup(
    createElement(CreativeApprovalControls, {
      creativeId: "cb61b3ff-6cdf-417e-b4e5-52f292419570",
      creativeStatus: toCreativeStatusToken(creativeStatus),
      creativeHasAsset: over.hasAsset ?? true,
      creativeHasAltText: over.hasAltText ?? true,
      postStatus: postStatus as never,
    }),
  );
}

// =====================================================================
// The exact contradiction, reproduced and prevented
// =====================================================================

describe("the creative guidance can never contradict the creative status", () => {
  it("an APPROVED creative is never told it must be approved", () => {
    // The production card, verbatim: creative approved, post paused.
    const html = renderControls("approved", "paused");
    expect(html).not.toMatch(/must be approved/i);
    expect(html).not.toMatch(/Approve the creative below/i);
    expect(html).toMatch(/Creative approved/i);
  });

  it.each(["draft", "pending_approval", "approved", "scheduled", "paused"])(
    "an approved creative stays approved at post status %s",
    (postStatus) => {
      const html = renderControls("approved", postStatus);
      expect(html).not.toMatch(/must be approved/i);
    },
  );

  it("a creative awaiting review DOES ask for approval", () => {
    const html = renderControls("pending_review", "pending_approval");
    expect(html).toMatch(/awaiting review/i);
  });

  it("a rejected creative says replace, not approve", () => {
    const html = renderControls("rejected", "pending_approval");
    expect(html).toMatch(/rejected/i);
    expect(html).toMatch(/replace/i);
  });

  it("the guidance takes the creative status as input at all", () => {
    // The defect was a function with NO parameters. Two different
    // statuses producing identical markup would mean it is back.
    expect(renderControls("approved", "pending_approval")).not.toBe(
      renderControls("pending_review", "pending_approval"),
    );
  });

  it("an approved creative missing alt text stays approved AND names the action", () => {
    // The user-specified copy: "Creative approved. Add alt text before
    // approving the post." — not "Creative must be approved…".
    const html = renderControls("approved", "pending_approval", {
      hasAltText: false,
    });
    expect(html).toMatch(/Creative approved/i);
    expect(html).toMatch(/add alt text/i);
    expect(html).not.toMatch(/must be approved/i);
  });

  it("an approved creative missing its asset stays approved AND names the action", () => {
    // Guards against the contradiction one row down: the status summary
    // reports "Creative missing asset" from describeCreativeState, so
    // guidance keyed only on status would promise an attachment that
    // would in fact block the publish.
    const html = renderControls("approved", "pending_approval", {
      hasAsset: false,
    });
    expect(html).toMatch(/Creative approved/i);
    expect(html).toMatch(/image file is missing/i);
    expect(html).not.toMatch(/will be attached/i);
  });

  it("the unconditional banner is gone from the source", () => {
    const source = stripComments(
      read("src/app/(app)/weekly-plan/_creative-approval-controls.tsx"),
    );
    expect(source).not.toContain("Creative must be approved");
    expect(source).not.toContain("function WorkflowBanner");
  });
});

// =====================================================================
// 12 — every approval surface uses the canonical evaluator
// =====================================================================

describe("12. approval surfaces share one evaluator", () => {
  it("the server gate consults evaluatePublishBlockers", () => {
    const source = stripComments(
      read("src/app/(app)/weekly-plan/approval-readiness.server.ts"),
    );
    expect(source).toContain("evaluatePublishBlockers");
  });

  it("the compose footer consults it too", () => {
    const source = stripComments(
      read("src/components/founder-compose/founder-compose-sheet.tsx"),
    );
    expect(source).toContain("evaluatePublishBlockers");
    expect(source).toContain("blockerMessage");
  });

  it("the weekly-plan card renders the persisted outcome and gates retry on it", () => {
    const source = stripComments(
      read("src/app/(app)/weekly-plan/_plan-item-card.tsx"),
    );
    expect(source).toContain("evaluateRetryEligibility");
    expect(source).toContain("resolvePublishingState");
    expect(source).toContain("publishOutcome");
  });

  it("the readiness verdict carries the structured blockers", () => {
    const shared = read("src/app/(app)/weekly-plan/approval-readiness.shared.ts");
    expect(shared).toContain("structured: PublishBlockerVerdict");
    expect(shared).toContain("identityAttached");
  });
});

// =====================================================================
// Retry affordance is outcome-gated, not status-gated
// =====================================================================

describe("Schedule retry is gated on the outcome, not on status", () => {
  // NOTE: the retry gate is pinned BEHAVIOURALLY in
  // incident-retry-affordance.test.ts, by rendering the card for each
  // outcome class. An earlier version asserted it here with
  // `expect(source).toContain("retryEligibility.operatorRetryAllowed")`
  // and the negative control proved that worthless — deleting the gate
  // from the JSX left the identifier in the variable declaration and
  // in the outcome strip's prop, so the test stayed green.

  it("the compose footer surfaces a canonical blocker, not just alt text", () => {
    // Before: the only blocker the footer knew was alt text, so it
    // offered an enabled "Schedule retry" on an item the scheduler was
    // certain to refuse.
    const withIdentityBlocker = deriveComposeActionState({
      status: "paused",
      hasItemId: true,
      hasTitle: false,
      titleRequired: false,
      hasBody: true,
      altTextMissing: false,
      blockerMessage: "Choose the identity to publish as.",
      autosaveInFlight: false,
      scheduleSet: true,
    });
    expect(withIdentityBlocker.primaryDisabled).toBe(true);
    expect(withIdentityBlocker.primaryBlocker).toMatch(/identity/i);
  });

  it("keeps the alt-text gate when no canonical blocker is supplied", () => {
    const legacy = deriveComposeActionState({
      status: "pending_approval",
      hasItemId: true,
      hasTitle: true,
      altTextMissing: true,
      autosaveInFlight: false,
    });
    expect(legacy.primaryDisabled).toBe(true);
    expect(legacy.primaryBlocker).toMatch(/alt text/i);
  });
});

// =====================================================================
// The operator is told what actually happened
// =====================================================================

describe("policy-gate refusals produce actionable copy", () => {
  it("account_not_confirmed no longer falls through to the generic", () => {
    const f = friendlyFailure({
      platform: "bluesky",
      reasonCode: "account_not_confirmed",
      reasonDetail: "Account review_status must be 'confirmed' (is 'unknown').",
    });
    // The production string.
    expect(f.title).not.toBe("Bluesky didn't publish this post.");
    expect(`${f.title} ${f.advice}`).toMatch(/identity/i);
    expect(`${f.title} ${f.advice}`).toMatch(/nothing was sent/i);
  });

  it.each([
    "product_not_confirmed",
    "publishing_disabled",
    "risk_level_blocked",
    "platform_not_supported",
    "no_active_contract",
  ])("%s has explicit copy", (reasonCode) => {
    const f = friendlyFailure({
      platform: "bluesky",
      reasonCode,
      reasonDetail: null,
    });
    expect(f.title).not.toBe("Bluesky didn't publish this post.");
  });

  it("says nothing was sent for gates that refuse pre-provider", () => {
    for (const reasonCode of [
      "account_not_confirmed",
      "product_not_confirmed",
      "publishing_disabled",
      "risk_level_blocked",
    ]) {
      const f = friendlyFailure({ platform: "bluesky", reasonCode, reasonDetail: null });
      expect(`${f.title} ${f.advice}`, reasonCode).toMatch(/nothing was sent/i);
    }
  });

  it("still falls back for genuinely unknown codes", () => {
    const f = friendlyFailure({
      platform: "bluesky",
      reasonCode: "something_new",
      reasonDetail: null,
    });
    expect(f.title).toBe("Bluesky didn't publish this post.");
  });
});

// =====================================================================
// 11 — mobile: the blocker strip cannot pan the card sideways
// =====================================================================

describe("11. the blocker strip is mobile-safe", () => {
  const source = read("src/app/(app)/weekly-plan/_plan-item-card.tsx");

  it("wraps long reason detail instead of overflowing", () => {
    const start = source.indexOf("function PublishOutcomeStrip");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\nfunction ", start + 10));
    // reason_detail is provider prose and reason_code is a long
    // underscored token; both must wrap inside the card.
    expect(body).toContain("break-words");
    expect(body).toContain("break-all");
  });

  it("uses no fixed or arbitrary width", () => {
    const start = source.indexOf("function PublishOutcomeStrip");
    const body = source.slice(start, source.indexOf("\nfunction ", start + 10));
    expect(body).not.toMatch(/\bw-\[/);
    expect(body).not.toMatch(/\bmin-w-\[/);
    expect(body).not.toMatch(/whitespace-nowrap/);
  });
});
