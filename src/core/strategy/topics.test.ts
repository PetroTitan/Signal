import { describe, expect, it } from "vitest";
import {
  MAX_DOC_FREQUENCY,
  MIN_DOCS_PER_CLUSTER,
  MIN_POSTS_FOR_CLUSTERING,
  buildTopicModel,
  describeTopicModel,
  dormantTopics,
  topicOf,
  type TopicDoc,
} from "./topics";

/** `startDay` also seeds the id, so several calls cannot collide. */
function docs(bodies: string[], startDay = 1): TopicDoc[] {
  return bodies.map((body, i) => ({
    id: `p${startDay}-${i}`,
    body,
    publishedAt: `2026-06-${String(startDay + i).padStart(2, "0")}T12:00:00Z`,
    platform: "x",
  }));
}

describe("false-precision guard", () => {
  it("caps clusters at sqrt(n), so 20 posts cannot make 37 topics", () => {
    const many = docs(Array.from({ length: 20 }, (_, i) => `unique${i} unique${i} distinct${i} separate${i}`));
    const model = buildTopicModel(many);
    expect(model.maxClusters).toBe(4);
    expect(model.clusters.length).toBeLessThanOrEqual(4);
  });

  it("requires a term in at least two posts before it is a topic", () => {
    const model = buildTopicModel(docs(["dashboards matter", "instrumentation matters"]));
    for (const c of model.clusters) expect(c.postCount).toBeGreaterThanOrEqual(MIN_DOCS_PER_CLUSTER);
  });

  it("excludes a term that appears in most posts — it groups nothing", () => {
    // Calibrated on the real corpus: "analytic" was in 57% of posts and
    // formed a cluster of 16 with zero co-occurring terms.
    const model = buildTopicModel(
      docs([
        "analytics dashboard clarity",
        "analytics workflow decision",
        "analytics instrumentation events",
        "analytics privacy restraint",
        "analytics review cadence",
        "unrelated zebra giraffe",
      ]),
    );
    expect(model.ubiquitousTerms.some((t) => t.term === "analytic")).toBe(true);
    expect(model.clusters.some((c) => c.key === "analytic")).toBe(false);
    expect(MAX_DOC_FREQUENCY).toBeLessThan(0.5);
  });

  it("assigns each post to exactly one topic so counts add up", () => {
    const model = buildTopicModel(
      docs([
        "dashboard friction workflow",
        "dashboard friction review",
        "privacy restraint measurement",
        "privacy restraint surveillance",
      ]),
    );
    const assigned = model.clusters.flatMap((c) => c.postIds);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned.length + model.unclustered.length).toBe(model.totalPosts);
  });
});

describe("explainability", () => {
  const CORPUS = [
    "dashboard friction review",
    "dashboard friction workflow",
    "privacy restraint measurement",
    "privacy restraint surveillance",
    "utterly singular phrasing zebra",
    "another unrelated subject giraffe",
  ];

  it("labels a cluster with a term that really appears in its posts", () => {
    const model = buildTopicModel(docs(CORPUS));
    const cluster = model.clusters[0];
    expect(cluster).toBeTruthy();
    for (const id of cluster.postIds) {
      const doc = docs(CORPUS).find((d) => d.id === id)!;
      expect(doc.body.toLowerCase()).toContain(cluster.key.slice(0, 6));
    }
  });

  it("explains why a post belongs to its topic", () => {
    const model = buildTopicModel(docs(CORPUS));
    const c = topicOf(model, model.clusters[0].postIds[0]);
    expect(c.evidence[0]).toContain("Shares the term");
  });

  it("says so when a post matches no topic, rather than inventing one", () => {
    const model = buildTopicModel(docs(CORPUS));
    const orphan = model.unclustered[0];
    expect(orphan).toBeTruthy();
    const c = topicOf(model, orphan);
    expect(c.value).toBe("unclustered");
    expect(c.confidence).toBe("none");
  });

  it("never claims strong confidence for a topic", () => {
    const model = buildTopicModel(docs(Array.from({ length: 12 }, () => "dashboard friction workflow review")));
    for (const c of model.clusters) {
      expect(topicOf(model, c.postIds[0]).confidence).not.toBe("strong");
    }
  });
});

describe("cold start", () => {
  it("handles an empty corpus without throwing", () => {
    const model = buildTopicModel([]);
    expect(model.clusters).toEqual([]);
    expect(model.totalPosts).toBe(0);
    expect(describeTopicModel(model)).toContain("Nothing published yet");
  });

  it("declines to cluster below the minimum corpus size, and says why", () => {
    // Two constants would otherwise collide silently: a cluster needs 2
    // posts, and a term in >45% of posts is excluded — so below n=5 no
    // cluster can form for reasons the operator cannot see.
    const model = buildTopicModel(docs(["a single first post about dashboards"]));
    expect(model.clusters).toEqual([]);
    expect(model.totalPosts).toBe(1);
    expect(describeTopicModel(model)).toContain(`at least ${MIN_POSTS_FOR_CLUSTERING}`);
  });

  it("says nothing groups yet when the corpus is big enough but nothing recurs", () => {
    const model = buildTopicModel(
      docs(["alpha unique", "bravo distinct", "charlie separate", "delta apart", "echo alone", "foxtrot solo"]),
    );
    expect(model.clusters).toEqual([]);
    expect(describeTopicModel(model)).toContain("nothing groups yet");
  });
});

describe("dormant topics", () => {
  it("finds topics not used recently", () => {
    const model = buildTopicModel([
      ...docs(["dashboard friction alpha", "dashboard clarity bravo"], 1),
      ...docs(["privacy restraint charlie", "privacy measurement delta"], 20),
      ...docs(["singular echo", "singular foxtrot"], 25),
    ]);
    expect(model.clusters.length).toBeGreaterThan(0);
    // 30 days after the early cluster, before the later ones age out.
    const dormant = dormantTopics(model, "2026-07-05T00:00:00Z", 30);
    expect(dormant.length).toBeGreaterThan(0);
    expect(dormant[0].lastPublishedAt < "2026-06-05T00:00:00Z").toBe(true);
  });

  it("reports none when everything is recent", () => {
    const model = buildTopicModel(
      docs(["dashboard friction", "dashboard clarity", "privacy restraint", "privacy limits", "alpha", "bravo"]),
    );
    expect(dormantTopics(model, "2026-06-08T00:00:00Z", 30)).toEqual([]);
  });
});
