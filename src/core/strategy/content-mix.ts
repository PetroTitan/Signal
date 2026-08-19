/**
 * Rolling content mix (PURE).
 *
 * COUNTS, NOT PERCENTAGES, AT SMALL n.
 * "40% product updates" from 5 posts is two posts wearing a decimal
 * point. Below a threshold this module reports "2 of 5", which is the
 * same information without the false precision. Percentages appear only
 * once the denominator can carry them.
 *
 * NO TARGET RATIOS. There is no ideal content mix, and this module does
 * not contain one. It reports what the mix IS and which dimensions are
 * untested — the operator decides what to do about it. A rule saying
 * "you should be 40/30/20/10" would be invented, and inventing it is
 * exactly what turns advice into enforcement.
 *
 * Pure module — no I/O, no clock.
 */

import type { ContentStrategyFeatures } from "./content-features";
import type { Archetype, CtaType, HookType } from "./classifiers";
import { ARCHETYPE_LABELS, CTA_LABELS, HOOK_LABELS } from "./classifiers";
import type { Classified } from "./evidence";

/** Below this many posts, report counts rather than percentages. */
export const MIN_N_FOR_PERCENTAGES = 10;

export interface MixEntry<T extends string> {
  value: T;
  label: string;
  count: number;
  /** Null below MIN_N_FOR_PERCENTAGES — the denominator cannot carry it. */
  percent: number | null;
  /** How confidently the underlying classifications were made. */
  weakClassifications: number;
}

export interface MixDimension<T extends string> {
  dimension: string;
  total: number;
  entries: MixEntry<T>[];
  /** Values in the vocabulary with zero posts — the untested space. */
  absent: T[];
  /** True when percentages are being shown. */
  usesPercentages: boolean;
  summary: string;
}

export interface ClassifiedForMix {
  features: ContentStrategyFeatures;
  archetype: Classified<Archetype>;
  hook: Classified<HookType>;
  cta: Classified<CtaType>;
  topic: Classified<string>;
}

function tally<T extends string>(
  dimension: string,
  items: readonly ClassifiedForMix[],
  pick: (item: ClassifiedForMix) => Classified<T>,
  labels: Partial<Record<T, string>>,
  vocabulary: readonly T[],
): MixDimension<T> {
  const total = items.length;
  const usesPercentages = total >= MIN_N_FOR_PERCENTAGES;

  const counts = new Map<T, { count: number; weak: number }>();
  for (const item of items) {
    const c = pick(item);
    const bucket = counts.get(c.value) ?? { count: 0, weak: 0 };
    bucket.count += 1;
    if (c.confidence === "weak" || c.confidence === "none") bucket.weak += 1;
    counts.set(c.value, bucket);
  }

  const entries: MixEntry<T>[] = Array.from(counts.entries())
    .map(([value, { count, weak }]) => ({
      value,
      label: labels[value] ?? String(value),
      count,
      percent: usesPercentages ? Math.round((count / total) * 100) : null,
      weakClassifications: weak,
    }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  const absent = vocabulary.filter((v) => !counts.has(v));

  return {
    dimension,
    total,
    entries,
    absent,
    usesPercentages,
    summary: describeMix(dimension, entries, total, usesPercentages),
  };
}

function describeMix<T extends string>(
  dimension: string,
  entries: readonly MixEntry<T>[],
  total: number,
  usesPercentages: boolean,
): string {
  if (total === 0) return `No posts to describe a ${dimension} mix.`;
  const parts = entries
    .slice(0, 4)
    .map((e) =>
      usesPercentages ? `${e.percent}% ${e.label.toLowerCase()}` : `${e.count} ${e.label.toLowerCase()}`,
    );
  const scope = usesPercentages ? `across ${total} posts` : `of ${total} posts`;
  return `${parts.join(", ")} ${scope}.`;
}

export interface ContentMix {
  total: number;
  archetypes: MixDimension<Archetype>;
  hooks: MixDimension<HookType>;
  ctas: MixDimension<CtaType>;
  topics: MixDimension<string>;
  /** Binary dimensions, reported as counts because they always are. */
  binary: {
    withLink: number;
    withoutLink: number;
    withCreative: number;
    withoutCreative: number;
    creativeUnknown: number;
    withQuestion: number;
    openingWithQuestion: number;
    closingWithQuestion: number;
    withHashtag: number;
    withMention: number;
    secondPerson: number;
  };
  byPlatform: Record<string, number>;
  summary: string;
}

export function buildContentMix(
  items: readonly ClassifiedForMix[],
  vocabularies: {
    archetypes: readonly Archetype[];
    hooks: readonly HookType[];
    ctas: readonly CtaType[];
    topics: readonly string[];
  },
): ContentMix {
  const total = items.length;

  const byPlatform: Record<string, number> = {};
  for (const item of items) {
    byPlatform[item.features.platform] = (byPlatform[item.features.platform] ?? 0) + 1;
  }

  const binary = {
    withLink: items.filter((i) => i.features.hasLink).length,
    withoutLink: items.filter((i) => !i.features.hasLink).length,
    withCreative: items.filter((i) => i.features.hasCreative === true).length,
    withoutCreative: items.filter((i) => i.features.hasCreative === false).length,
    // Unknown is its own count. Folding it into "without" would assert
    // an absence that was never measured.
    creativeUnknown: items.filter((i) => i.features.hasCreative == null).length,
    withQuestion: items.filter((i) => i.features.hasQuestion).length,
    openingWithQuestion: items.filter((i) => i.features.opensWithQuestion).length,
    closingWithQuestion: items.filter((i) => i.features.closesWithQuestion).length,
    withHashtag: items.filter((i) => i.features.hashtagCount > 0).length,
    withMention: items.filter((i) => i.features.mentionCount > 0).length,
    secondPerson: items.filter((i) => i.features.usesSecondPerson).length,
  };

  const archetypes = tally("archetype", items, (i) => i.archetype, ARCHETYPE_LABELS, vocabularies.archetypes);
  const hooks = tally("hook", items, (i) => i.hook, HOOK_LABELS, vocabularies.hooks);
  const ctas = tally("CTA", items, (i) => i.cta, CTA_LABELS, vocabularies.ctas);
  const topics = tally("topic", items, (i) => i.topic, {}, vocabularies.topics);

  return {
    total,
    archetypes,
    hooks,
    ctas,
    topics,
    binary,
    byPlatform,
    summary:
      total === 0
        ? "Nothing published yet."
        : `${total} recent post(s). ${archetypes.summary} ${hooks.summary}`,
  };
}

/**
 * Dimensions with no coverage at all — the input to explore
 * recommendations. Reported as FACTS, since "you have never done X" is
 * directly countable and needs no performance data.
 */
export interface UntestedDimension {
  dimension: string;
  value: string;
  label: string;
  /** The countable fact behind it. */
  fact: string;
}

export function untestedDimensions(mix: ContentMix): UntestedDimension[] {
  const out: UntestedDimension[] = [];
  if (mix.total === 0) return out;

  if (mix.binary.openingWithQuestion === 0) {
    out.push({
      dimension: "hook",
      value: "question",
      label: "Question-led opening",
      fact: `None of your last ${mix.total} posts opens with a question.`,
    });
  }
  if (mix.binary.closingWithQuestion === 0) {
    out.push({
      dimension: "cta",
      value: "ask_question",
      label: "Closing question",
      fact: `None of your last ${mix.total} posts ends with a question.`,
    });
  }
  const noCta = mix.ctas.entries.find((e) => e.value === "none");
  if (noCta && noCta.count === mix.total) {
    out.push({
      dimension: "cta",
      value: "any",
      label: "Any call to action",
      fact: `None of your last ${mix.total} posts contains a call to action.`,
    });
  }
  if (mix.binary.withLink === 0) {
    out.push({
      dimension: "format",
      value: "link",
      label: "A post carrying a link",
      fact: `None of your last ${mix.total} posts carries a link.`,
    });
  }
  if (mix.binary.withCreative === 0 && mix.binary.creativeUnknown < mix.total) {
    out.push({
      dimension: "format",
      value: "creative",
      label: "A post with an image",
      fact: `None of your last ${mix.total} posts has a creative attached.`,
    });
  }
  if (mix.binary.secondPerson === 0) {
    out.push({
      dimension: "voice",
      value: "second_person",
      label: "Addressing the reader directly",
      fact: `None of your last ${mix.total} posts addresses the reader as "you".`,
    });
  }

  // Archetypes never used. Capped so this stays advice rather than a
  // checklist of every label in the vocabulary.
  const interesting: Archetype[] = [
    "question",
    "personal_story",
    "case_study",
    "data_insight",
    "educational",
  ];
  for (const value of interesting) {
    if (mix.archetypes.absent.includes(value)) {
      out.push({
        dimension: "archetype",
        value,
        label: ARCHETYPE_LABELS[value],
        fact: `You have not published a post classified as ${ARCHETYPE_LABELS[value].toLowerCase()} in this window.`,
      });
    }
  }

  return out;
}

/**
 * Dimensions that dominate the mix. Reported without judgement — a
 * concentrated feed is a fact, not a fault.
 */
export function dominantDimensions(mix: ContentMix, threshold = 0.6): string[] {
  if (mix.total < 3) return [];
  const out: string[] = [];

  const topArchetype = mix.archetypes.entries[0];
  if (topArchetype && topArchetype.count / mix.total >= threshold) {
    out.push(
      `${topArchetype.count} of your last ${mix.total} posts are ${topArchetype.label.toLowerCase()}.`,
    );
  }
  const topHook = mix.hooks.entries[0];
  if (topHook && topHook.count / mix.total >= threshold) {
    out.push(
      `${topHook.count} of your last ${mix.total} posts open with the same kind of hook (${topHook.label.toLowerCase()}).`,
    );
  }
  return out;
}
