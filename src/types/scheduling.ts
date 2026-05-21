import type { PlatformId } from "./platform";
import type { ContentType, RiskLevel } from "./plan";

export interface ScheduledPost {
  id: string;
  planItemId: string;
  accountId: string;
  productId: string;
  platform: PlatformId;
  contentType: ContentType;
  scheduledFor: string;
  status: "queued" | "publishing" | "published" | "failed" | "cancelled";
  riskLevel: RiskLevel;
}
