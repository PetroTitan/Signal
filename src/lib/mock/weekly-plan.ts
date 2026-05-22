import type { BacklogItem, RiskScore, WeeklyPlan, WeeklyPlanItem } from "@/types";

const seedRisk: RiskScore = {
  score: 0,
  level: "low",
  reasons: [],
  recommendation: "Safe to publish on schedule.",
};

export const currentWeeklyPlan: WeeklyPlan = {
  id: "plan_2026_w21",
  workspaceId: "ws_helperg",
  weekStartIso: "2026-05-18T00:00:00.000Z",
  weekEndIso: "2026-05-24T23:59:59.000Z",
  status: "awaiting_approval",
};

export const weeklyPlanItems: WeeklyPlanItem[] = [
  {
    id: "item_001",
    planId: currentWeeklyPlan.id,
    accountId: "acc_petro_linkedin_founder",
    productId: "prod_helperg",
    platform: "linkedin",
    contentType: "long_form_article",
    draft: {
      id: "draft_001",
      hook: "The weekly approval gate: how I stopped overposting",
      body: "Notes from running a small portfolio without posting daily. The Monday review replaced everything else. Less posting, more presence.",
      cta: null,
      trackingLinkId: null,
    },
    scheduledFor: "2026-05-20T09:00:00.000Z",
    status: "approved",
    risk: seedRisk,
  },
  {
    id: "item_002",
    planId: currentWeeklyPlan.id,
    accountId: "acc_wmi_x_product",
    productId: "prod_webmasterid",
    platform: "x",
    contentType: "discussion_post",
    draft: {
      id: "draft_002",
      hook: "Most analytics stacks treat agent traffic as one bucket",
      body: "We started splitting visits three ways: classic bots, AI agents, and humans. The shape of the funnel changes when you do.",
      cta: "Free tier at webmasterid.com",
      trackingLinkId: "link_wmi_001",
    },
    scheduledFor: "2026-05-20T14:30:00.000Z",
    status: "pending_approval",
    risk: seedRisk,
  },
  {
    id: "item_003",
    planId: currentWeeklyPlan.id,
    accountId: "acc_petro_x_founder",
    productId: "prod_helperg",
    platform: "x",
    contentType: "thread",
    draft: {
      id: "draft_003",
      hook: "Six months running HELPERG without a growth hack",
      body: "Notes from running a small portfolio without paid ads or cold outreach. What moved the needle, what didn't, and what I'd do differently.",
      cta: null,
      trackingLinkId: null,
    },
    scheduledFor: "2026-05-21T15:00:00.000Z",
    status: "approved",
    risk: seedRisk,
  },
  {
    id: "item_004",
    planId: currentWeeklyPlan.id,
    accountId: "acc_cw_x_product",
    productId: "prod_cash_workspace",
    platform: "x",
    contentType: "discussion_post",
    draft: {
      id: "draft_004",
      hook: "Revenue is not available cash",
      body: "Freelancers often confuse revenue with available cash because taxes are future liabilities. Three columns settle the question every solo operator asks.",
      cta: "I built this for myself: cashworkspace.com",
      trackingLinkId: "link_cw_001",
    },
    scheduledFor: "2026-05-22T13:00:00.000Z",
    status: "pending_approval",
    risk: seedRisk,
  },
];

export const initialBacklog: BacklogItem[] = [
  {
    id: "bk_seed_001",
    workspaceId: "ws_helperg",
    accountId: "acc_wmi_x_product",
    productId: "prod_webmasterid",
    platform: "x",
    contentType: "case_study",
    draft: {
      id: "draft_bk_001",
      hook: "A week of agent traffic, by user-agent family",
      body: "Reserved follow-up. Held to keep WebmasterID X cadence balanced.",
      cta: null,
      trackingLinkId: null,
    },
    risk: seedRisk,
    movedFromPlanItemId: null,
    reason: "Held to keep WebmasterID X cadence balanced.",
    movedAt: "2026-05-15T10:00:00.000Z",
  },
];
