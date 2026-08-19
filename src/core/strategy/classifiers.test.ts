import { describe, expect, it } from "vitest";
import { extractFeatures, lengthBandsFor, firstSentence } from "./content-features";
import {
  ARCHETYPES,
  CTA_TYPES,
  HOOK_TYPES,
  classifyArchetype,
  classifyCta,
  classifyHook,
} from "./classifiers";
import { containsStrategyOverclaim } from "./evidence";

/** Real posts from the production corpus. */
const REAL = {
  contrarian: "Privacy-first analytics is not blind analytics.\n\nIt means collecting with restraint, keeping useful context, and avoiding measurement that creates more risk than value.",
  announcement: "9 apps live. Not one of them is cool. ZIP extractor. PDF editor. Printer utility. CV builder. Invoice maker. Card scanner. No brand needed, no launch needed, no trend to catch. People search for the function, find the app, install it.",
  product: "Most analytics tools still treat AI crawlers as noise.\n\nWebmasterID separates people, search bots, AI crawlers, and AI referrals so operators can see how the machine-readable web is actually reading their site.",
  advice: "Before adding another analytics event, write the question first.\n\nWhat decision should this signal make easier?\n\nIf the answer is unclear, the event will probably become dashboard noise.",
  plain: "Evidence needs a loop.\n\nAnalytics shows the situation. A decision changes something. Review shows whether the change worked.\n\nWithout that loop, dashboards become opinion with nicer formatting.",
  listy: "Dashboards are useful when they improve the operating picture.\n\nWhat changed?\nWhat stayed unclear?\nWhere did friction appear?\nWhich decision should move next?\n\nIf those answers are missing, the issue is usually the data model.",
};

function feat(body: string, platform = "x") {
  return extractFeatures({
    id: "p", platform, accountId: "a", handle: "h",
    publishedAt: "2026-06-01T12:00:00Z", title: null, body, linkUrl: null,
  });
}

describe("feature extraction", () => {
  it("measures the real shape of a real post", () => {
    const f = feat(REAL.contrarian);
    expect(f.wordCount).toBeGreaterThan(20);
    expect(f.paragraphCount).toBe(2);
    expect(f.hasQuestion).toBe(false);
    expect(f.hashtagCount).toBe(0);
    expect(f.mentionCount).toBe(0);
    expect(f.hasLink).toBe(false);
  });

  it("distinguishes a question ANYWHERE from one that opens or closes", () => {
    // The real corpus has 7/28 containing a question but only 1/28
    // closing with one — rhetorical lists, not invitations to reply.
    const f = feat(REAL.listy);
    expect(f.hasQuestion).toBe(true);
    expect(f.opensWithQuestion).toBe(false);
    expect(f.closesWithQuestion).toBe(false);
  });

  it("scales length bands per platform, because length varies 15x", () => {
    expect(lengthBandsFor("x")[0]).toBeLessThan(lengthBandsFor("devto")[0]);
    // 29 words is a normal X post and a tiny dev.to article.
    expect(feat(REAL.plain, "x").lengthBand).not.toBe("very_short");
    expect(feat(REAL.plain, "devto").lengthBand).toBe("very_short");
  });

  it("does not split a sentence on a period inside a word", () => {
    expect(firstSentence("Ship to dev.to first. Then elsewhere.")).toBe("Ship to dev.to first.");
  });

  it("returns zeros and empties, never guesses, for an empty body", () => {
    const f = feat("");
    expect(f.wordCount).toBe(0);
    expect(f.openingSentence).toBe("");
    expect(f.hasDistinctClosing).toBe(false);
  });
});

describe("archetype classification", () => {
  it("returns evidence, never a bare label", () => {
    const c = classifyArchetype(feat(REAL.contrarian), REAL.contrarian);
    expect(c.evidence.length).toBeGreaterThan(0);
    expect(ARCHETYPES).toContain(c.value);
  });

  it("recognises an announcement from a leading count and launch language", () => {
    const c = classifyArchetype(feat(REAL.announcement), REAL.announcement);
    expect(c.value).toBe("announcement");
    expect(c.evidence.join(" ")).toContain("Opens with a count");
  });

  it("recognises a product post when the product is named", () => {
    const c = classifyArchetype(feat(REAL.product), REAL.product, {
      productNames: ["WebmasterID"],
    });
    expect(c.value).toBe("product_update");
    expect(c.evidence.join(" ")).toContain("WebmasterID");
  });

  it("does NOT map the topic classifier's no-match default into an archetype", () => {
    // classifyTopic returns operational_observation for 26 of 28 real
    // posts because that is its fallback. Mapping it would manufacture a
    // confident archetype from "nothing matched".
    const c = classifyArchetype(feat(REAL.plain), REAL.plain);
    expect(c.evidence.join(" ")).not.toContain("operational_observation");
  });

  it("falls back to weak commentary rather than a confident label", () => {
    const c = classifyArchetype(feat(REAL.plain), REAL.plain);
    expect(c.value).toBe("industry_commentary");
    expect(c.confidence).toBe("weak");
    expect(c.evidence[0]).toContain("Impersonal declarative claim");
  });

  it("never reports strong confidence from a single signal", () => {
    for (const body of Object.values(REAL)) {
      const c = classifyArchetype(feat(body), body, { productNames: ["WebmasterID"] });
      if (c.evidence.length === 1) expect(c.confidence).not.toBe("strong");
    }
  });
});

describe("hook classification", () => {
  it("labels the contrarian opening the corpus uses 9 times in 28", () => {
    expect(classifyHook(feat(REAL.contrarian)).value).toBe("contrarian");
  });

  it("labels a leading figure as a statistic hook", () => {
    expect(classifyHook(feat(REAL.announcement)).value).toBe("statistic");
  });

  it("labels an imperative opening as advice", () => {
    expect(classifyHook(feat(REAL.advice)).value).toBe("advice");
  });

  it("recognises a question opening — which this corpus never uses", () => {
    const body = "What does your analytics actually tell you?\n\nMost dashboards answer a different question.";
    expect(classifyHook(feat(body)).value).toBe("question");
  });

  it("falls back to statement with WEAK confidence, not silence", () => {
    const c = classifyHook(feat(REAL.plain));
    expect(HOOK_TYPES).toContain(c.value);
    expect(c.confidence).toBe("weak");
    expect(c.evidence[0]).toContain("no more specific pattern");
  });

  it("returns unknown for an empty opening", () => {
    const c = classifyHook(feat(""));
    expect(c.value).toBe("unknown");
    expect(c.confidence).toBe("none");
  });
});

describe("CTA classification", () => {
  it("reports none for 27 of 28 real posts — a real finding, not a fallback", () => {
    const c = classifyCta(feat(REAL.plain), REAL.plain);
    expect(c.value).toBe("none");
    expect(c.confidence).toBe("strong");
    expect(CTA_TYPES).toContain(c.value);
  });

  it("does NOT read a descriptive verb as a call to action", () => {
    // "People search for the function, find the app, install it."
    // contains "install" but asks nothing of the reader.
    expect(classifyCta(feat(REAL.announcement), REAL.announcement).value).toBe("none");
  });

  it("DOES read an imperative closing as a call to action", () => {
    const body = "Analytics should be boring.\n\nTry it and see.";
    expect(classifyCta(feat(body), body).value).toBe("try_product");
  });

  it("DOES read a second-person closing as a call to action", () => {
    const body = "Analytics should be boring.\n\nYou can download the guide here.";
    expect(classifyCta(feat(body), body).value).toBe("download");
  });

  it("treats a closing question as an invitation to answer", () => {
    const body = "Most dashboards answer the wrong question.\n\nWhat would yours need to show?";
    expect(classifyCta(feat(body), body).value).toBe("ask_question");
  });
});

describe("no classifier output makes a causal claim", () => {
  it("emits nothing that predicts performance", () => {
    for (const body of Object.values(REAL)) {
      const f = feat(body);
      const texts = [
        ...classifyArchetype(f, body, { productNames: ["WebmasterID"] }).evidence,
        ...classifyHook(f).evidence,
        ...classifyCta(f, body).evidence,
      ];
      for (const t of texts) expect(containsStrategyOverclaim(t), t).toBe(false);
    }
  });
});
