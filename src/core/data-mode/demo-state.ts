import type {
  ContentAsset,
  GrowthAccount,
  ProductProfile,
  RiskEvent,
  SourceInsight,
  WeeklyPlan,
  WeeklyPlanItem,
  BacklogItem,
} from "@/types";
import type { DiscussionSeed } from "@/lib/mock/discussions";

/**
 * The canonical "what does demo mode actually expose?" type. Everything the
 * UI might read in demo mode is enumerated here so the boundary stays
 * narrow and the rest of the app does not import from `@/lib/mock`
 * directly.
 */
export interface DemoState {
  accounts: GrowthAccount[];
  products: ProductProfile[];
  plan: WeeklyPlan;
  items: WeeklyPlanItem[];
  backlog: BacklogItem[];
  sourceInsights: SourceInsight[];
  discussionSeeds: DiscussionSeed[];
  contentAssets: ContentAsset[];
  riskEvents: RiskEvent[];
}

/**
 * Lazy loader for the demo fixtures. Imported only when demo mode is on,
 * so the mock module is never on the critical path for real users.
 */
export async function loadDemoState(): Promise<DemoState> {
  const mock = await import("@/lib/mock");
  return {
    accounts: mock.accounts,
    products: mock.products,
    plan: mock.currentWeeklyPlan,
    items: mock.weeklyPlanItems,
    backlog: mock.initialBacklog,
    sourceInsights: mock.sourceInsights,
    discussionSeeds: mock.discussionSeeds,
    contentAssets: mock.contentAssets,
    riskEvents: mock.riskEvents,
  };
}

/**
 * Synchronous loader used by the shell when the React boundary must be
 * resolved at render time. Returns the same shape as loadDemoState().
 */
export function loadDemoStateSync(
  mock: typeof import("@/lib/mock"),
): DemoState {
  return {
    accounts: mock.accounts,
    products: mock.products,
    plan: mock.currentWeeklyPlan,
    items: mock.weeklyPlanItems,
    backlog: mock.initialBacklog,
    sourceInsights: mock.sourceInsights,
    discussionSeeds: mock.discussionSeeds,
    contentAssets: mock.contentAssets,
    riskEvents: mock.riskEvents,
  };
}
