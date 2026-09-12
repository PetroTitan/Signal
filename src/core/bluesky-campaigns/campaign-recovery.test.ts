import { describe, expect, it } from "vitest";
import {
  describeFailedCampaign,
  isResumableCampaignStatus,
  RESUMABLE_CAMPAIGN_STATUSES,
} from "./campaign-recovery";

describe("campaign recovery", () => {
  it("allows an operator to recover every non-terminal stopped state", () => {
    expect(RESUMABLE_CAMPAIGN_STATUSES).toEqual([
      "draft",
      "paused",
      "reauthorization_required",
      "failed",
    ]);
    for (const status of RESUMABLE_CAMPAIGN_STATUSES) {
      expect(isResumableCampaignStatus(status)).toBe(true);
    }
  });

  it("never reopens active, rate-limited, completed or cancelled work", () => {
    for (const status of [
      "active",
      "rate_limited",
      "completed",
      "cancelled",
    ] as const) {
      expect(isResumableCampaignStatus(status)).toBe(false);
    }
  });

  it("does not misattribute an internal dispatcher failure to Bluesky", () => {
    const copy = describeFailedCampaign({
      errorCode: "dispatch_error",
      errorMessage: "DELETE requires a WHERE clause",
    });
    expect(copy).toContain("Signal's campaign worker");
    expect(copy).toContain("DELETE requires a WHERE clause");
    expect(copy).not.toContain("Bluesky returned");
  });

  it("keeps provider failures distinct", () => {
    expect(
      describeFailedCampaign({
        errorCode: "provider_rejected",
        errorMessage: "InvalidRequest",
      }),
    ).toContain("Bluesky returned");
  });
});
