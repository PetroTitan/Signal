import type { RiskEvent } from "@/types";

export const riskEvents: RiskEvent[] = [
  {
    id: "risk_001",
    category: "overposting",
    level: "medium",
    accountId: "acc_wmi_x_product",
    productId: "prod_webmasterid",
    platform: "x",
    detectedAt: "2026-05-19T08:00:00.000Z",
    summary: "WebmasterID X has two promotional items in the plan this week.",
    recommendation: "Move one to the backlog. Suggested cooldown: 4 days.",
  },
  {
    id: "risk_002",
    category: "promotional_tone",
    level: "medium",
    accountId: "acc_cw_x_product",
    productId: "prod_cash_workspace",
    platform: "x",
    detectedAt: "2026-05-19T08:30:00.000Z",
    summary: "Cash Workspace post compares directly to a competitor.",
    recommendation: "Lead with the problem, not the competitor.",
  },
  {
    id: "risk_003",
    category: "platform_cadence",
    level: "low",
    productId: "prod_helperg",
    platform: "linkedin",
    detectedAt: "2026-05-19T08:30:00.000Z",
    summary: "HELPERG LinkedIn cadence is on plan this week.",
    recommendation: "No action needed.",
  },
];
