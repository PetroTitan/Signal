import type {
  ActivityEvent,
  ApprovalEvent,
  BacklogItem,
  ContentAsset,
  DiscussionOpportunity,
  GrowthAccount,
  ProductProfile,
  RiskEvent,
  SourceInsight,
  WeeklyPlan,
  WeeklyPlanItem,
} from "@/types";
import { calculateDiscoverabilityOpportunities } from "../discoverability";
import { buildOpportunitiesForInsight } from "../content-intelligence";
import { adaptToGoogle } from "../platform-adapters";

interface DeriveInput {
  plan: WeeklyPlan;
  items: WeeklyPlanItem[];
  backlog: BacklogItem[];
  approvalEvents: ApprovalEvent[];
  accountsById: Record<string, GrowthAccount>;
  productsById: Record<string, ProductProfile>;
  riskEvents: RiskEvent[];
  contentAssets: ContentAsset[];
  insights: SourceInsight[];
  lastMoves: { id: string; from: string; to: string; reason: string }[];
}

export function deriveActivity(input: DeriveInput): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  for (const insight of input.insights) {
    events.push({
      id: `act_ins_${insight.id}`,
      occurredAt: insight.createdAt,
      type: "insight_created",
      entityType: "insight",
      layer: "intelligence",
      productId: insight.productId,
      severity: "info",
      title: `Insight: ${insight.title}`,
      explanation: `${insight.category.replace(/_/g, " ")} added to the insight library.`,
      link: "/weekly-plan",
    });
  }

  for (const account of Object.values(input.accountsById)) {
    events.push({
      id: `act_acc_${account.id}`,
      occurredAt: account.createdAt,
      type: "account_created",
      entityType: "account",
      layer: "configuration",
      platform: account.platform,
      productId: account.productId,
      severity: "info",
      title: `Account created: ${account.displayName}`,
      explanation: `${account.platform.toUpperCase()} account, role ${account.role}, current status ${account.status.replace(/_/g, " ")}.`,
      link: `/accounts/${account.id}`,
    });
    if (account.lastActivityAt) {
      events.push({
        id: `act_acc_status_${account.id}`,
        occurredAt: account.lastActivityAt,
        type: "account_readiness_changed",
        entityType: "account",
        layer: "configuration",
        platform: account.platform,
        productId: account.productId,
        severity: severityForAccountStatus(account.status),
        title: `${account.displayName} → ${account.status.replace(/_/g, " ")}`,
        explanation: `Readiness ${account.readinessScore}%.`,
        link: `/accounts/${account.id}`,
      });
    }
  }

  for (const item of input.items) {
    events.push({
      id: `act_item_created_${item.id}`,
      occurredAt: item.scheduledFor,
      type: "draft_created",
      entityType: "weekly_item",
      layer: "intelligence",
      platform: item.platform,
      productId: item.productId,
      severity: severityForRiskLevel(item.risk.level),
      title: `Draft scheduled: ${item.draft.hook}`,
      explanation: `${item.platform.toUpperCase()} ${item.contentType.replace(/_/g, " ")}, risk ${item.risk.level} (${item.risk.score}).`,
      link: "/weekly-plan",
    });
    if (item.risk.level === "high" || item.risk.level === "blocked") {
      events.push({
        id: `act_item_risk_${item.id}`,
        occurredAt: item.scheduledFor,
        type: "risk_flagged",
        entityType: "weekly_item",
        layer: "core",
        platform: item.platform,
        productId: item.productId,
        severity: item.risk.level === "blocked" ? "block" : "warn",
        title: `Risk: ${item.draft.hook}`,
        explanation: item.risk.recommendation,
        link: "/weekly-plan",
      });
    }
  }

  for (const ev of input.approvalEvents) {
    const item = input.items.find((i) => i.id === ev.planItemId);
    events.push({
      id: `act_appr_${ev.id}`,
      occurredAt: ev.occurredAt,
      type:
        ev.action === "approve"
          ? "item_approved"
          : ev.action === "reject"
            ? "item_rejected"
            : "item_backlogged",
      entityType: "weekly_item",
      layer: "operations",
      platform: item?.platform,
      productId: item?.productId,
      severity:
        ev.action === "reject"
          ? "block"
          : ev.action === "save_to_backlog"
            ? "info"
            : "ok",
      title: titleForApproval(ev, item),
      explanation: ev.note ?? `${ev.action.replace(/_/g, " ")} by ${ev.actorEmail}.`,
      link: "/weekly-plan",
    });
  }

  for (const bk of input.backlog) {
    events.push({
      id: `act_bk_${bk.id}`,
      occurredAt: bk.movedAt,
      type: "item_backlogged",
      entityType: "backlog_item",
      layer: "operations",
      platform: bk.platform,
      productId: bk.productId,
      severity: "info",
      title: `Backlogged: ${bk.draft.hook}`,
      explanation: bk.reason,
      link: "/backlog",
    });
  }

  for (const move of input.lastMoves) {
    const item = input.items.find((i) => i.id === move.id);
    events.push({
      id: `act_move_${move.id}_${move.to}`,
      occurredAt: move.to,
      type: "schedule_redistributed",
      entityType: "schedule",
      layer: "core",
      platform: item?.platform,
      productId: item?.productId,
      severity: "info",
      title: `Schedule shift: ${item?.draft.hook ?? move.id}`,
      explanation: move.reason,
      link: "/execution",
    });
  }

  for (const risk of input.riskEvents) {
    events.push({
      id: `act_risk_${risk.id}`,
      occurredAt: risk.detectedAt,
      type: "risk_flagged",
      entityType: "risk",
      layer: "core",
      platform: risk.platform,
      productId: risk.productId,
      severity:
        risk.level === "high" || risk.level === "blocked"
          ? "block"
          : risk.level === "medium"
            ? "warn"
            : "info",
      title: risk.summary,
      explanation: risk.recommendation,
      link: "/weekly-plan",
    });
  }

  const products = Object.values(input.productsById);
  for (const insight of input.insights) {
    const product = input.productsById[insight.productId];
    if (!product) continue;
    const opps = buildOpportunitiesForInsight({ insight, product });
    for (const opp of opps.slice(0, 2)) {
      events.push({
        id: `act_opp_${opp.id}`,
        occurredAt: insight.createdAt,
        type: "opportunity_generated",
        entityType: "opportunity",
        layer: "intelligence",
        platform: opp.channel === "google" ? "google" : opp.channel,
        productId: opp.productId,
        severity: opp.impact === "high" ? "warn" : "info",
        title: opp.title,
        explanation: opp.rationale,
        link: "/weekly-plan",
      });
    }
    const googleOpps = adaptToGoogle({
      insight,
      product,
      assets: input.contentAssets,
    });
    for (const g of googleOpps.slice(0, 1)) {
      events.push({
        id: `act_gop_${g.id}`,
        occurredAt: insight.createdAt,
        type: "discoverability_opportunity",
        entityType: "discoverability",
        layer: "platform_search",
        platform: "google",
        productId: insight.productId,
        severity: g.impact === "high" ? "warn" : "info",
        title: g.title,
        explanation: g.suggestedAction,
        link: "/platforms/google",
      });
    }
  }

  const assetOpps = calculateDiscoverabilityOpportunities(
    input.contentAssets,
    products,
  );
  for (const ao of assetOpps.slice(0, 6)) {
    events.push({
      id: `act_asset_op_${ao.id}`,
      occurredAt: input.plan.weekStartIso,
      type: "discoverability_opportunity",
      entityType: "discoverability",
      layer: "platform_search",
      platform: "google",
      productId: ao.productId,
      severity: ao.impact === "high" ? "warn" : "info",
      title: ao.title,
      explanation: ao.suggestedAction,
      link: "/weekly-plan",
    });
  }

  return events.sort(
    (a, b) =>
      new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );
}

export function deriveDiscussionActivity(input: {
  discussionOpportunities: DiscussionOpportunity[];
  referenceTime?: number;
}): ActivityEvent[] {
  const now = input.referenceTime ?? Date.now();
  const out: ActivityEvent[] = [];
  for (const d of input.discussionOpportunities) {
    const occurredAt = new Date(now - d.ageHours * 60 * 60 * 1000).toISOString();
    if (d.recommendation === "skip") {
      out.push({
        id: `act_skip_${d.id}`,
        occurredAt,
        type: "thread_skipped",
        entityType: "discussion",
        layer: "intelligence",
        platform: d.platform,
        severity: "info",
        title: `Skipped: ${d.threadTitle}`,
        explanation: d.skipReason ?? "Discussion engine recommended skip.",
        link: "/weekly-plan",
      });
    } else if (d.matchedInsightIds.length > 0) {
      out.push({
        id: `act_disc_${d.id}`,
        occurredAt,
        type: "comment_drafted",
        entityType: "discussion",
        layer: "intelligence",
        platform: d.platform,
        severity: "info",
        title: `Discussion match: ${d.threadTitle}`,
        explanation: `Score ${d.participationScore}, fit ${d.communityFit.level.replace(/_/g, " ")}.`,
        link: "/weekly-plan",
      });
    }
  }
  return out;
}

function titleForApproval(ev: ApprovalEvent, item?: WeeklyPlanItem): string {
  const hook = item?.draft.hook ?? ev.planItemId;
  switch (ev.action) {
    case "approve":
      return `Approved: ${hook}`;
    case "reject":
      return `Rejected: ${hook}`;
    case "save_to_backlog":
      return `Saved to backlog: ${hook}`;
    case "rewrite_softer":
      return `Rewritten softer: ${hook}`;
    case "remove_link":
      return `Link removed: ${hook}`;
    case "delay":
      return `Delayed: ${hook}`;
    case "convert_to_comment":
      return `Converted to comment: ${hook}`;
    default:
      return `${ev.action.replace(/_/g, " ")}: ${hook}`;
  }
}

function severityForAccountStatus(
  status: GrowthAccount["status"],
): ActivityEvent["severity"] {
  if (status === "active") return "ok";
  if (
    status === "warming" ||
    status === "ready_to_connect" ||
    status === "connected"
  )
    return "info";
  if (status === "paused") return "warn";
  return "info";
}

function severityForRiskLevel(level: string): ActivityEvent["severity"] {
  if (level === "blocked") return "block";
  if (level === "high") return "warn";
  if (level === "medium") return "warn";
  return "info";
}
