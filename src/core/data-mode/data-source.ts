import type { ContentAsset, RiskEvent, SourceInsight } from "@/types";
import type { DiscussionSeed } from "@/lib/mock/discussions";
import type { DemoState } from "./demo-state";

/**
 * A `DataSource` is the only place in Signal that knows whether a given
 * read should hit real state, a demo fixture, or a future server.
 * Components ask the data source; the data source decides.
 *
 * In normal mode, every reader returns an empty array. In demo mode, the
 * reader returns the fixtures from the loaded DemoState. There is no
 * third option today — when persistence ships, this is where it slots in.
 */
export interface DataSource {
  readonly mode: "real" | "demo";
  readSourceInsights(): SourceInsight[];
  readDiscussionSeeds(): DiscussionSeed[];
  readContentAssets(): ContentAsset[];
  readRiskEvents(): RiskEvent[];
}

export class RealDataSource implements DataSource {
  readonly mode = "real" as const;
  readSourceInsights(): SourceInsight[] {
    return [];
  }
  readDiscussionSeeds(): DiscussionSeed[] {
    return [];
  }
  readContentAssets(): ContentAsset[] {
    return [];
  }
  readRiskEvents(): RiskEvent[] {
    return [];
  }
}

export class DemoDataSource implements DataSource {
  readonly mode = "demo" as const;
  constructor(private snapshot: DemoState) {}
  readSourceInsights(): SourceInsight[] {
    return this.snapshot.sourceInsights;
  }
  readDiscussionSeeds(): DiscussionSeed[] {
    return this.snapshot.discussionSeeds;
  }
  readContentAssets(): ContentAsset[] {
    return this.snapshot.contentAssets;
  }
  readRiskEvents(): RiskEvent[] {
    return this.snapshot.riskEvents;
  }
}

export function makeDataSource(
  mode: "real" | "demo",
  snapshot: DemoState | null,
): DataSource {
  if (mode === "demo" && snapshot) {
    return new DemoDataSource(snapshot);
  }
  return new RealDataSource();
}
