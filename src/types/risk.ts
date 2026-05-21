import type { PlatformId } from "./platform";
import type { RiskLevel } from "./plan";

export type RiskCategory =
  | "duplicate_content"
  | "link_repetition"
  | "overposting"
  | "synchronized_posting"
  | "promotional_tone"
  | "account_fatigue"
  | "platform_cadence";

export interface RiskEvent {
  id: string;
  category: RiskCategory;
  level: RiskLevel;
  accountId?: string;
  productId?: string;
  platform?: PlatformId;
  detectedAt: string;
  summary: string;
  recommendation: string;
}
