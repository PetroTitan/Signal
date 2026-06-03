import { describe, expect, it } from "vitest";
import { describeActivityEvent } from "./activity-feed-labels";

function ev(
  eventType: string,
  metadata: Record<string, unknown> = {},
  title = "raw title",
) {
  return { eventType, title, metadata };
}

describe("describeActivityEvent", () => {
  it("maps a publish completion to a platform-suffixed line", () => {
    expect(describeActivityEvent(ev("item.completed", { platform: "bluesky" }))).toEqual({
      label: "Published to Bluesky",
      tone: "success",
    });
  });

  it("falls back to a generic published line when platform is unknown", () => {
    expect(describeActivityEvent(ev("item.completed"))).toEqual({
      label: "Published",
      tone: "success",
    });
  });

  it("maps creative approval", () => {
    expect(
      describeActivityEvent(ev("weekly_plan_item.creative_approved")).label,
    ).toBe("Creative approved");
  });

  it("maps post approval", () => {
    expect(describeActivityEvent(ev("weekly_plan_item.approved")).label).toBe(
      "Post approved",
    );
  });

  it("maps schedule updates to the info tone", () => {
    const line = describeActivityEvent(ev("weekly_plan_item.schedule_changed"));
    expect(line.label).toBe("Schedule updated");
    expect(line.tone).toBe("info");
  });

  it("maps failures to the danger tone", () => {
    expect(describeActivityEvent(ev("item.failed")).tone).toBe("danger");
  });

  it("falls back to the event's own title for unknown event types", () => {
    expect(
      describeActivityEvent(ev("some.brand_new_event", {}, "A brand new thing")),
    ).toEqual({ label: "A brand new thing", tone: "muted" });
  });

  it("reads target_platform metadata too", () => {
    expect(
      describeActivityEvent(ev("manual_publish.recorded", { target_platform: "x" })).label,
    ).toBe("Published to X");
  });
});
