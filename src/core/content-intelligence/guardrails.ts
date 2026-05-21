import type { GuardrailFlag, GuardrailReport } from "@/types";

const aggressiveCtaPhrases = [
  "buy now",
  "sign up today",
  "limited time",
  "act fast",
  "don't miss",
  "click here",
  "join now",
];

const launchSpamPhrases = [
  "🚀",
  "introducing",
  "mega",
  "huge announcement",
  "the future of",
  "game changer",
  "disrupt",
];

const fakeCertaintyPhrases = [
  "guaranteed",
  "100%",
  "every founder",
  "always works",
  "never fails",
];

const startupCliches = [
  "synergy",
  "10x your",
  "hockey stick",
  "north star",
  "move fast and break things",
  "killing it",
];

const aiVoicePhrases = [
  "in today's fast-paced",
  "in the realm of",
  "delve into",
  "navigate the landscape",
  "unlock the potential",
  "dive deep into",
];

const lowContextPhrases = [
  "great post",
  "love this",
  "+1",
  "this is gold",
  "agreed",
];

interface CheckInput {
  hook: string;
  body: string;
  cta: string | null;
  knownHooks: string[];
}

export function scanText(input: CheckInput): GuardrailReport {
  const flags: GuardrailFlag[] = [];
  const notes: string[] = [];
  const text = `${input.hook}\n${input.body}\n${input.cta ?? ""}`.toLowerCase();

  const matches = (phrases: string[]) =>
    phrases.filter((p) => text.includes(p.toLowerCase()));

  const agg = matches(aggressiveCtaPhrases);
  if (agg.length > 0 || (input.cta && /![ ]?$/.test(input.cta))) {
    flags.push("cta_too_aggressive");
    if (agg.length > 0) {
      notes.push(`CTA wording leans aggressive: ${agg.join(", ")}`);
    } else {
      notes.push("CTA ends with an exclamation — soften.");
    }
  }

  const launch = matches(launchSpamPhrases);
  if (launch.length > 0) {
    flags.push("launch_language");
    notes.push(`Launch-spam phrasing detected: ${launch.join(", ")}`);
  }

  const certainty = matches(fakeCertaintyPhrases);
  if (certainty.length > 0) {
    flags.push("fake_certainty");
    notes.push(`Overstated certainty: ${certainty.join(", ")}`);
  }

  const cliches = matches(startupCliches);
  if (cliches.length > 0) {
    flags.push("startup_cliche");
    notes.push(`Startup cliché detected: ${cliches.join(", ")}`);
  }

  const ai = matches(aiVoicePhrases);
  if (ai.length > 0) {
    flags.push("ai_voice");
    notes.push("Phrasing reads like AI-generated prose — rewrite in operator voice.");
  }

  const lowCtx = matches(lowContextPhrases);
  if (lowCtx.length > 0 && input.body.trim().length < 80) {
    flags.push("low_context");
    notes.push("Body is short and matches a generic agreement pattern.");
  }

  if (
    !text.includes("for example") &&
    !text.match(/\b\d{1,4}(?:k|m|%|x| dollars| customers| users)?\b/) &&
    /every|always|all|never/.test(text)
  ) {
    flags.push("unsupported_claim");
    notes.push("Universal claim with no concrete example or number.");
  }

  const hookLower = input.hook.trim().toLowerCase();
  if (
    hookLower.length > 0 &&
    input.knownHooks
      .map((h) => h.trim().toLowerCase())
      .includes(hookLower)
  ) {
    flags.push("duplicate_hook");
    notes.push("Hook duplicates one already used recently.");
  }

  const repeatedWord = repeatedWordsAcross(input.hook, input.body);
  if (repeatedWord.length > 0) {
    flags.push("repeated_wording");
    notes.push(
      `Repeated key words between hook and body: ${repeatedWord.join(", ")}`,
    );
  }

  if (
    /^[^.!?]*$/.test(input.body.trim()) &&
    input.body.trim().length < 60
  ) {
    flags.push("generic_phrasing");
    notes.push("Body is short and lacks a complete sentence — add substance.");
  }

  const passes = flags.length === 0;
  return { flags, notes, passes };
}

function repeatedWordsAcross(hook: string, body: string): string[] {
  const hookWords = new Set(tokenize(hook));
  const repeats: string[] = [];
  for (const word of new Set(tokenize(body))) {
    if (hookWords.has(word) && word.length > 5) {
      repeats.push(word);
      if (repeats.length >= 3) break;
    }
  }
  return repeats;
}

const stopwords = new Set([
  "about",
  "after",
  "again",
  "and",
  "because",
  "before",
  "between",
  "both",
  "could",
  "from",
  "have",
  "into",
  "more",
  "other",
  "should",
  "their",
  "there",
  "these",
  "they",
  "this",
  "those",
  "very",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
  "your",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z\s']/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !stopwords.has(w));
}

export const guardrailLabels: Record<GuardrailFlag, string> = {
  cta_too_aggressive: "CTA too aggressive",
  repeated_wording: "Repeated wording",
  duplicate_hook: "Duplicate hook",
  low_context: "Low-context phrasing",
  launch_language: "Launch-spam language",
  fake_certainty: "Overstated certainty",
  unsupported_claim: "Unsupported claim",
  startup_cliche: "Startup cliché",
  ai_voice: "AI-voice phrasing",
  generic_phrasing: "Generic phrasing",
};
