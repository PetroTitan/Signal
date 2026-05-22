import type { WeeklyPlanItem } from "@/types";

export interface DriftSignal {
  itemA: string;
  itemB: string;
  similarity: number;
  reason: string;
}

const STOPWORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "have",
  "your",
  "their",
  "there",
  "into",
  "what",
  "when",
  "which",
  "would",
  "could",
  "should",
  "about",
  "between",
  "because",
]);

export function detectCrossPlatformSimilarity(
  items: Pick<WeeklyPlanItem, "id" | "platform" | "draft">[],
  threshold = 0.55,
): DriftSignal[] {
  const tokens = items.map((item) => ({
    id: item.id,
    platform: item.platform,
    tokens: tokenize(`${item.draft.hook} ${item.draft.body}`),
  }));

  const signals: DriftSignal[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      const a = tokens[i];
      const b = tokens[j];
      if (a.platform === b.platform) continue;
      const sim = jaccard(a.tokens, b.tokens);
      if (sim >= threshold) {
        signals.push({
          itemA: a.id,
          itemB: b.id,
          similarity: Math.round(sim * 100) / 100,
          reason: `Cross-platform overlap between ${a.platform} and ${b.platform} items.`,
        });
      }
    }
  }
  return signals;
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 5) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const v of a) if (b.has(v)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
