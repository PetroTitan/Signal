import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * "Schedule retry" must be gated on the OUTCOME, not on the status.
 *
 * This file exists because the first version of the guard was a source
 * assertion — `expect(source).toContain("retryEligibility.operatorRetryAllowed")`
 * — and the negative control proved it worthless: deleting the gate
 * from the JSX condition left the identifier in the variable
 * declaration and the strip's prop, so the test stayed green.
 *
 * These render the real card and assert on the real markup.
 *
 * Why it matters: `applyOutcome` mirrors both `blocked` and `failed`
 * to `plan_item.status = "paused"` regardless of outcome class, so a
 * class C (unknown) or class D (partial) attempt lands in exactly the
 * same `paused` + scheduled shape as the class A incident. A
 * status-shaped gate cannot tell them apart.
 */

vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useFormState: (_action: unknown, initial: unknown) => [initial, () => {}],
    useFormStatus: () => ({ pending: false }),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => "/weekly-plan",
  useSearchParams: () => new URLSearchParams(),
}));

import { PlanItemCard } from "./_plan-item-card";
import type { PersistedPublishOutcome } from "@/core/publishing/retry-eligibility";

/**
 * The incident card: Bluesky, paused, scheduled, approved creative
 * with alt text. Everything except `publishOutcome` is held constant
 * so the outcome is the only variable.
 */
function renderCard(publishOutcome: PersistedPublishOutcome | null): string {
  return renderToStaticMarkup(
    createElement(PlanItemCard, {
      id: "7be1588e-1421-4b15-bae5-00cbe87de61c",
      title: null,
      body: "9 apps live. Not one of them is cool.",
      platform: "bluesky",
      contentType: "post",
      productId: "2891f802-f2dd-42c1-b0f6-b5a2b49a3b01",
      accountId: "8096e0b4-ff98-4f1c-8746-b8870c043d71",
      scheduledAt: "2026-08-15T13:55:00+00:00",
      scheduleSource: "manual",
      status: "paused",
      riskScore: 25,
      notes: null,
      isPost: true,
      isApprovable: true,
      warnings: [],
      timezoneLabel: "UTC",
      subreddit: null,
      products: [],
      accounts: [
        {
          id: "8096e0b4-ff98-4f1c-8746-b8870c043d71",
          displayName: "Petro Hrys",
          platform: "bluesky",
        },
      ],
      allowedSubreddits: ["test"],
      hasActiveContract: false,
      creative: {
        id: "cb61b3ff-6cdf-417e-b4e5-52f292419570",
        creativeType: "image",
        sourceType: "uploaded",
        status: "approved",
        assetUrl: "https://storage.example/creative.jpg",
        sourceUrl: null,
        altText: "#myiosapps",
        license: null,
        attribution: null,
        prompt: null,
        mimeType: "image/jpeg",
        sizeBytes: 188028,
        uploadedAt: "2026-08-15T11:44:44Z",
      },
      executionItemId: "88be67cc-839b-478c-ade4-bb776417d96c",
      executionItemStatus: "blocked",
      publishOutcome,
      platformPublishIntent: null,
      aiAssistedKind: null,
      scheduleDisplay: {
        local: "15 Aug 13:55",
        utc: "2026-08-15T13:55:00Z",
        timezone: "UTC",
        relative: null,
        dueState: "due",
        sourceLabel: "plan item",
        source: "plan_item",
        effectiveScheduledAt: "2026-08-15T13:55:00+00:00",
        divergenceWarning: null,
      } as never,
    } as never),
  );
}

/** The exact persisted outcome from execution item 88be67cc. */
const CLASS_A: PersistedPublishOutcome = {
  status: "blocked",
  reason_code: "account_not_confirmed",
  reason_detail: "Account review_status must be 'confirmed' (is 'unknown').",
  external_id: null,
  external_url: null,
};

const CLASS_C: PersistedPublishOutcome = {
  status: "failed",
  reason_code: "publish_outcome_unknown",
  reason_detail: "Dispatched but never confirmed.",
  external_id: null,
  external_url: null,
};

const CLASS_D: PersistedPublishOutcome = {
  status: "failed",
  reason_code: "publish_partial_success",
  reason_detail: "Thread part 2 of 3 failed.",
  external_id: null,
  external_url: null,
};

const CLASS_E: PersistedPublishOutcome = {
  status: "failed",
  reason_code: "platform_api_error",
  reason_detail: "Timed out after create.",
  external_id: null,
  external_url: "https://bsky.app/profile/petrohrys.bsky.social/post/abc",
};

describe("class A — safe, provider never attempted", () => {
  const html = renderCard(CLASS_A);

  it("offers Schedule retry", () => {
    // Correct for the incident: nothing was sent, so nothing can be
    // duplicated.
    expect(html).toContain("Schedule retry");
  });

  it("explains that nothing was sent", () => {
    expect(html).toMatch(/nothing was sent/i);
  });

  it("names the real cause instead of the generic failure copy", () => {
    expect(html).toMatch(/identity/i);
    expect(html).not.toContain("Bluesky didn&#x27;t publish this post.");
  });

  it("shows the persisted reason code without needing DEBUG", () => {
    expect(html).toContain("account_not_confirmed");
  });
});

describe("class C — unknown outcome", () => {
  const html = renderCard(CLASS_C);

  it("HIDES Schedule retry", () => {
    // The status shape is identical to class A: paused + scheduled.
    // Only the outcome distinguishes them.
    expect(html).not.toContain("Schedule retry");
  });

  it("tells the operator to check the platform first", () => {
    expect(html).toMatch(/check the platform/i);
  });
});

describe("class D — partial success", () => {
  const html = renderCard(CLASS_D);

  it("HIDES Schedule retry", () => {
    expect(html).not.toContain("Schedule retry");
  });

  it("says the post is partly published", () => {
    expect(html).toMatch(/partly published/i);
  });
});

describe("class E — provider evidence of publication", () => {
  const html = renderCard(CLASS_E);

  it("HIDES Schedule retry even though the row says failed", () => {
    // Provider evidence outranks the status field.
    expect(html).not.toContain("Schedule retry");
  });
});

describe("no prior attempt", () => {
  it("renders no outcome strip at all", () => {
    const html = renderCard(null);
    expect(html).not.toMatch(/nothing was sent/i);
    expect(html).not.toMatch(/Publishing blocked/i);
  });
});

describe("the creative stays approved throughout", () => {
  it.each([
    ["A", CLASS_A],
    ["C", CLASS_C],
    ["D", CLASS_D],
  ])("class %s never claims the creative needs approval", (_label, outcome) => {
    const html = renderCard(outcome as PersistedPublishOutcome);
    expect(html).not.toMatch(/must be approved/i);
    expect(html).toMatch(/Creative approved/i);
  });
});
