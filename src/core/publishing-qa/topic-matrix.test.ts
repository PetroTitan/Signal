import { describe, expect, it } from "vitest";
import { affinityFor, classifyTopic, TOPIC_AFFINITY } from "./topic-matrix";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";
import type { TopicKind } from "./types";

const ALL_PLATFORMS: FounderPlatform[] = [
  "reddit",
  "devto",
  "hashnode",
  "bluesky",
  "indie_hackers",
  "x",
  "linkedin",
  "youtube",
  "threads",
  "instagram",
  "telegram",
];

describe("TOPIC_AFFINITY matrix integrity", () => {
  it("covers every platform for every topic kind", () => {
    for (const [topic, row] of Object.entries(TOPIC_AFFINITY)) {
      for (const p of ALL_PLATFORMS) {
        expect(
          (row as Record<FounderPlatform, unknown>)[p],
          `${topic} missing affinity for ${p}`,
        ).toBeDefined();
      }
    }
  });
});

describe("classifyTopic", () => {
  it("classifies an architecture write-up as architecture_deep_dive", () => {
    const text =
      "An architecture note. The data model is sharded by workspace id. We chose a consistency model that trades strong reads for write throughput; the decision record is below.";
    expect(classifyTopic(text)).toBe("architecture_deep_dive");
  });

  it("classifies a tutorial-style engineering article", () => {
    const text =
      "In this article we'll cover how to detect AI crawlers in Next.js. Here's how to add the middleware. ```ts ... ``` See the github.com link.";
    expect(classifyTopic(text)).toBe("engineering_article");
  });

  it("classifies a discussion question", () => {
    const text =
      "Open question: has anyone noticed AI crawler share growing in their logs?";
    expect(classifyTopic(text)).toBe("discussion_question");
  });

  it("classifies a Telegram-style changelog", () => {
    const text = "Changelog — release notes for this week. We shipped:";
    expect(classifyTopic(text)).toBe("changelog");
  });

  it("classifies a launch announcement", () => {
    const text =
      "Today we're launching the first version of the agent-aware analytics layer. Now available in public beta.";
    expect(classifyTopic(text)).toBe("launch_announcement");
  });

  it("falls back to operational_observation when nothing matches", () => {
    expect(classifyTopic("Just thinking out loud about bot traffic shapes.")).toBe(
      "operational_observation",
    );
  });
});

describe("affinityFor — coverage of the user's matrix examples", () => {
  const cases: Array<[TopicKind, FounderPlatform, string]> = [
    ["architecture_deep_dive", "hashnode", "native"],
    ["architecture_deep_dive", "instagram", "forbidden"],
    ["architecture_deep_dive", "threads", "forbidden"],
    ["promotional", "reddit", "forbidden"],
    ["launch_announcement", "reddit", "forbidden"],
    ["changelog", "telegram", "native"],
    ["discussion_question", "reddit", "native"],
    ["operator_lesson", "indie_hackers", "native"],
    ["visual_storytelling", "instagram", "native"],
    ["long_form_explainer", "youtube", "native"],
    ["industry_summary", "linkedin", "native"],
    ["operational_observation", "x", "native"],
    ["reflective_commentary", "bluesky", "native"],
    ["founder_observation", "threads", "native"],
    ["engineering_article", "devto", "native"],
    ["engineering_article", "hashnode", "native"],
  ];
  it.each(cases)("%s on %s is %s", (topic, platform, expected) => {
    expect(affinityFor(topic, platform)).toBe(expected);
  });
});
