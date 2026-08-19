import { describe, expect, it } from "vitest";
import {
  INTERPRETATION_SYSTEM_PROMPT,
  MAX_INTERPRETATION_CHARS,
  buildInterpretationPrompt,
  interpretationUnavailableNote,
  numbersIn,
  validateInterpretation,
} from "./ai-interpretation";

const EVIDENCE = {
  statements: [
    "28 posts published across 3 platforms in the last 90 days.",
    "No post has been measured yet.",
    "None of your last 28 posts opens with a question.",
  ],
  options: [
    { title: "Try a question-led opening", rationale: "You have never published one." },
  ],
  gaps: ["Engagement is unmeasured on every post."],
};

const prompt = buildInterpretationPrompt(EVIDENCE);

describe("the prompt", () => {
  it("hands the model the deterministic evidence verbatim", () => {
    for (const statement of EVIDENCE.statements) {
      expect(prompt.user).toContain(statement);
    }
  });

  it("collects the numbers the model is allowed to restate", () => {
    expect(prompt.allowedNumbers.has("28")).toBe(true);
    expect(prompt.allowedNumbers.has("90")).toBe(true);
    expect(prompt.allowedNumbers.has("41")).toBe(false);
  });

  it("forbids the specific failure modes rather than describing a persona", () => {
    expect(INTERPRETATION_SYSTEM_PROMPT).toContain("Never claim that anything caused anything");
    expect(INTERPRETATION_SYSTEM_PROMPT).toContain("Never instruct");
    expect(INTERPRETATION_SYSTEM_PROMPT).toContain("Use only the numbers");
  });

  it("names the gaps so the model states them instead of filling them", () => {
    expect(prompt.user).toContain("KNOWN GAPS");
    expect(prompt.user).toContain("do not fill them");
  });
});

describe("the invented-number guard", () => {
  it("accepts an interpretation that only restates given numbers", () => {
    const result = validateInterpretation(
      "You have published 28 posts across 3 platforms in the last 90 days, and none of them has been measured. That means the options below rest on what you published, not on how it did.",
      prompt.allowedNumbers,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects the plausible sentence, which is the dangerous one", () => {
    const result = validateInterpretation(
      "Engagement is up about 40% on question-led posts, so that pattern looks promising.",
      prompt.allowedNumbers,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("invented_number");
  });

  it("rejects a number that was merely rounded into a different figure", () => {
    const result = validateInterpretation(
      "You have published roughly 30 posts recently.",
      prompt.allowedNumbers,
    );
    expect(result.ok === false && result.reason).toBe("invented_number");
  });

  it("treats a decimal and its integer as different numbers", () => {
    const allowed = numbersIn("1.4 posts a week");
    expect(validateInterpretation("About 1.4 posts a week.", allowed).ok).toBe(true);
    expect(validateInterpretation("About 2 posts a week.", allowed).ok).toBe(false);
  });

  it("says the deterministic findings are unaffected when it rejects", () => {
    const result = validateInterpretation("Impressions rose 12%.", prompt.allowedNumbers);
    expect(result.ok === false && result.detail).toContain("deterministic findings above are unaffected");
  });
});

describe("the claim guards", () => {
  it("rejects a causal story", () => {
    const result = validateInterpretation(
      "The reason your reach dropped is that the algorithm penalises posts published through an API.",
      prompt.allowedNumbers,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["causal_claim", "overclaim"]).toContain(result.reason);
  });

  it("rejects an instruction", () => {
    const result = validateInterpretation(
      "You should post a question next.",
      prompt.allowedNumbers,
    );
    expect(result.ok === false && result.reason).toBe("gave_an_instruction");
  });

  it("allows the same idea phrased as an option", () => {
    const result = validateInterpretation(
      "One option is a question-led opening, which you have not published before.",
      prompt.allowedNumbers,
    );
    expect(result.ok).toBe(true);
  });
});

describe("boundaries", () => {
  it("rejects an empty response", () => {
    expect(validateInterpretation("   ", prompt.allowedNumbers).ok).toBe(false);
  });

  it("discards an over-long response rather than truncating mid-sentence", () => {
    const long = "Nothing has been measured. ".repeat(80);
    expect(long.length).toBeGreaterThan(MAX_INTERPRETATION_CHARS);
    const result = validateInterpretation(long, prompt.allowedNumbers);
    expect(result.ok === false && result.reason).toBe("too_long");
  });

  it("explains its absence without calling it an error", () => {
    for (const reason of ["no_provider", "provider_error", "invented_number"] as const) {
      const note = interpretationUnavailableNote(reason);
      expect(note).toContain("Everything above is computed without it");
      expect(note.toLowerCase()).not.toContain("failed");
    }
  });
});
