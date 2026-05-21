import type {
  ContentMemoryRecord,
  ContentMemorySummary,
  OpportunityChannel,
  SourceInsight,
  WeeklyPlanItem,
} from "@/types";

const DAY_MS = 24 * 60 * 60 * 1000;

interface BuildMemoryInput {
  insights: SourceInsight[];
  items: WeeklyPlanItem[];
  weekStartIso: string;
  insightByHook?: Map<string, string>;
}

export function buildMemoryRecords({
  insights,
  items,
  weekStartIso,
  insightByHook,
}: BuildMemoryInput): ContentMemoryRecord[] {
  const records = new Map<string, ContentMemoryRecord>();
  const hookMap = insightByHook ?? defaultHookMap(insights);

  for (const item of items) {
    const insightId = hookMap.get(item.draft.hook.trim().toLowerCase());
    if (!insightId) continue;
    const existing = records.get(insightId);
    const channels = new Set<OpportunityChannel>(existing?.channels ?? []);
    channels.add(item.platform);
    records.set(insightId, {
      insightId,
      weekStartIso,
      channels: Array.from(channels),
    });
  }
  return Array.from(records.values());
}

function defaultHookMap(insights: SourceInsight[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const insight of insights) {
    map.set(insight.title.trim().toLowerCase(), insight.id);
    map.set(insight.coreInsight.trim().toLowerCase(), insight.id);
  }
  return map;
}

export function summarizeMemory({
  insights,
  items,
  weekStartIso,
}: BuildMemoryInput): ContentMemorySummary {
  const records = buildMemoryRecords({ insights, items, weekStartIso });
  const usedInsightIds = new Set(records.map((r) => r.insightId));

  const evergreenAvailable = insights.filter(
    (i) => i.evergreenScore >= 60 && !usedInsightIds.has(i.id),
  ).length;
  const stale = insights.filter((i) => isStale(i, weekStartIso)).length;
  const underused = insights.filter(
    (i) =>
      i.conversationScore >= 50 &&
      i.evergreenScore >= 30 &&
      !usedInsightIds.has(i.id),
  ).length;

  const hookCounts = countHooks(items);
  const repeated = Array.from(hookCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([hook, count]) => ({ hook, count }))
    .slice(0, 6);

  return {
    totalInsights: insights.length,
    usedThisWeek: usedInsightIds.size,
    usedPriorWeek: 0,
    evergreenAvailable,
    stale,
    underused,
    repeatedHooks: repeated,
  };
}

function isStale(insight: SourceInsight, weekStartIso: string): boolean {
  const created = new Date(insight.createdAt).getTime();
  const week = new Date(weekStartIso).getTime();
  return week - created > 180 * DAY_MS;
}

function countHooks(items: WeeklyPlanItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    const key = item.draft.hook.trim().toLowerCase();
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

export function recentlyUsedHooks(items: WeeklyPlanItem[]): string[] {
  return Array.from(new Set(items.map((i) => i.draft.hook.trim())));
}
