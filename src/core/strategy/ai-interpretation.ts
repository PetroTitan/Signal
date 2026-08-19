/**
 * Optional AI interpretation (PURE).
 *
 * The AI's job here is NARROW: take evidence that has already been
 * computed deterministically and say it in a way an operator can read in
 * one pass. It does not decide, does not rank, does not measure, and
 * does not get a vote on what ships.
 *
 * THE WHOLE FEATURE IS OPTIONAL. Every screen and every tool works with
 * this module returning nothing — no provider key, no interpretation, no
 * degradation. If that ever stops being true, the layering has been
 * inverted and the fix is here, not in the caller.
 *
 * THE INVENTED-NUMBER GUARD
 * -------------------------
 * The failure mode that matters is not a clumsy sentence, it is a
 * plausible one: "engagement is up about 40% on question-led posts" from
 * a model that was given no such number. So the validator extracts every
 * number in the output and rejects the whole interpretation unless each
 * one appears in the evidence the model was handed. A model that cannot
 * restate a number without inventing one gets no section at all, which
 * is the correct outcome — the deterministic evidence above it is still
 * on the screen.
 *
 * Rejection is not an error state. It is the guard working.
 *
 * Pure module — no I/O. The provider call lives in the .server file.
 */

import { containsCausalClaim } from "@/core/intelligence/statistics";
import { containsStrategyOverclaim } from "./evidence";

/** Longer than this and it has stopped summarising. */
export const MAX_INTERPRETATION_CHARS = 1200;

export type InterpretationRejection =
  | "no_provider"
  | "provider_error"
  | "empty"
  | "too_long"
  | "invented_number"
  | "causal_claim"
  | "overclaim"
  | "gave_an_instruction";

export type InterpretationResult =
  | {
      ok: true;
      /** Always rendered under an explicit AI INTERPRETATION label. */
      text: string;
      /** The numbers it was permitted to use, for the audit trail. */
      allowedNumbers: string[];
    }
  | {
      ok: false;
      reason: InterpretationRejection;
      /** Operator-readable, and safe to show — never the raw output. */
      detail: string;
    };

export interface InterpretationEvidence {
  /** Deterministic statements, verbatim. The model may only restate these. */
  statements: string[];
  /** The options the operator is being shown, by title and rationale. */
  options: Array<{ title: string; rationale: string }>;
  /** What is known to be unmeasured, so the model can say so plainly. */
  gaps: string[];
}

/**
 * The system prompt.
 *
 * Written as a set of refusals rather than a persona, because the
 * failure modes are specific: a model asked to "be a social media
 * strategist" will confidently produce benchmarks, best practices, and
 * causal stories, none of which exist in the evidence.
 */
export const INTERPRETATION_SYSTEM_PROMPT = [
  "You summarise evidence that has already been computed. You are not an analyst and not a strategist.",
  "",
  "RULES, in order of importance:",
  "1. Use only the numbers that appear in the evidence below. Never compute a new one, never estimate, never round into a different figure, never introduce a benchmark or an industry average.",
  "2. Never claim that anything caused anything. The evidence is descriptive and small. Say what was recorded, not why.",
  "3. Never instruct. The operator decides. Write 'one option is' rather than 'you should', and never imply an option is required.",
  "4. Never invent a fact about the account, the platforms, or the audience that is not in the evidence.",
  "5. When the evidence says something is unmeasured, say it is unmeasured. Do not fill the gap.",
  "",
  "STYLE: plain prose, at most three short paragraphs, no lists, no headings, no numbering, no emoji.",
  "Write for one experienced operator reading quickly. If the evidence supports nothing interesting, say that in one sentence.",
].join("\n");

export function buildInterpretationPrompt(evidence: InterpretationEvidence): {
  system: string;
  user: string;
  allowedNumbers: Set<string>;
} {
  const lines: string[] = ["EVIDENCE (deterministic, already verified):"];
  for (const statement of evidence.statements) lines.push(`- ${statement}`);

  if (evidence.options.length > 0) {
    lines.push("", "OPTIONS CURRENTLY SHOWN TO THE OPERATOR:");
    for (const option of evidence.options) {
      lines.push(`- ${option.title}: ${option.rationale}`);
    }
  }

  if (evidence.gaps.length > 0) {
    lines.push("", "KNOWN GAPS (state these plainly, do not fill them):");
    for (const gap of evidence.gaps) lines.push(`- ${gap}`);
  }

  lines.push(
    "",
    "Summarise the above for the operator. Do not add numbers, causes, benchmarks, or instructions.",
  );

  const user = lines.join("\n");
  return {
    system: INTERPRETATION_SYSTEM_PROMPT,
    user,
    allowedNumbers: numbersIn(user),
  };
}

/** Every number in a text, normalised so "40" and "40.0" compare equal. */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(/-?\d+(?:[.,]\d+)?/g)) {
    const normalised = Number(match[0].replace(",", "."));
    if (Number.isFinite(normalised)) out.add(String(normalised));
  }
  return out;
}

/** Phrases that turn a summary into an instruction. */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /\byou should\b/i,
  /\byou need to\b/i,
  /\byou must\b/i,
  /\bmake sure (?:you|to)\b/i,
  /\bstop (?:posting|publishing|doing)\b/i,
  /\bthe (?:right|correct|best) (?:approach|strategy|move) is\b/i,
];

export function validateInterpretation(
  raw: string,
  allowedNumbers: ReadonlySet<string>,
): InterpretationResult {
  const text = raw.trim();

  if (text.length === 0) {
    return { ok: false, reason: "empty", detail: "The model returned nothing." };
  }
  if (text.length > MAX_INTERPRETATION_CHARS) {
    return {
      ok: false,
      reason: "too_long",
      detail: `The interpretation exceeded ${MAX_INTERPRETATION_CHARS} characters, so it was discarded rather than truncated mid-sentence.`,
    };
  }

  const invented = Array.from(numbersIn(text)).filter((n) => !allowedNumbers.has(n));
  if (invented.length > 0) {
    return {
      ok: false,
      reason: "invented_number",
      detail:
        "The interpretation contained a number that does not appear in the evidence, so it was discarded. " +
        "The deterministic findings above are unaffected.",
    };
  }

  if (containsCausalClaim(text)) {
    return {
      ok: false,
      reason: "causal_claim",
      detail:
        "The interpretation claimed a cause the data cannot support, so it was discarded.",
    };
  }

  if (containsStrategyOverclaim(text)) {
    return {
      ok: false,
      reason: "overclaim",
      detail:
        "The interpretation overstated what the evidence shows, so it was discarded.",
    };
  }

  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      ok: false,
      reason: "gave_an_instruction",
      detail:
        "The interpretation told the operator what to do rather than describing the evidence, so it was discarded.",
    };
  }

  return { ok: true, text, allowedNumbers: Array.from(allowedNumbers).sort() };
}

/** What the operator sees when there is no interpretation. Never an error. */
export function interpretationUnavailableNote(reason: InterpretationRejection): string {
  switch (reason) {
    case "no_provider":
      return "AI interpretation is off. Everything above is computed without it.";
    case "provider_error":
      return "AI interpretation was unavailable this time. Everything above is computed without it.";
    default:
      return "The AI interpretation was discarded by the safety check. Everything above is computed without it.";
  }
}
