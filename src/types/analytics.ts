import type { PlatformId } from "./platform";

export interface TrackingLink {
  id: string;
  productId: string;
  destinationUrl: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  signalCampaignId: string;
  signalItemId: string;
  platform: PlatformId;
  accountId: string;
  createdAt: string;
}

export interface PerformanceMetric {
  id: string;
  productId: string;
  platform: PlatformId;
  accountId?: string;
  metric: "visits" | "sessions" | "signups" | "engagement_quality" | "conversions";
  value: number | null;
  status: "not_connected" | "pending" | "ready";
  capturedAt: string | null;
}
