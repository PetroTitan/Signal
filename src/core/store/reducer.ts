import type {
  AccountRole,
  AccountStatus,
  ApprovalEvent,
  BacklogItem,
  GrowthAccount,
  PlatformId,
  ProductProfile,
  WeeklyPlan,
  WeeklyPlanItem,
} from "@/types";
import {
  applyDelay,
  convertToComment,
  fromBacklog,
  planMeta,
  removeLink,
  rewriteSofter,
  toBacklog,
} from "../approval/transitions";
import { redistributeAll } from "../scheduler/distribute";
import { scoreAllItems } from "../risk/score";
import { buildSetupKit, computeReadiness } from "../onboarding";

export interface SignalState {
  plan: WeeklyPlan;
  items: WeeklyPlanItem[];
  backlog: BacklogItem[];
  approvalEvents: ApprovalEvent[];
  accountsById: Record<string, GrowthAccount>;
  productsById: Record<string, ProductProfile>;
  lastMoves: { id: string; from: string; to: string; reason: string }[];
}

export type SignalAction =
  | { type: "approve"; itemId: string }
  | { type: "approve_all_low_risk" }
  | { type: "reject"; itemId: string; reason?: string }
  | { type: "delay"; itemId: string; hours?: number }
  | { type: "remove_link"; itemId: string }
  | { type: "rewrite_softer"; itemId: string }
  | { type: "convert_to_comment"; itemId: string }
  | { type: "save_to_backlog"; itemId: string; reason?: string }
  | { type: "pause"; itemId: string }
  | { type: "resume"; itemId: string }
  | { type: "duplicate_next_week"; itemId: string }
  | { type: "restore_from_backlog"; backlogId: string }
  | { type: "redistribute" }
  | {
      type: "create_account";
      input: {
        id: string;
        platform: PlatformId;
        productId: string;
        role: AccountRole;
        displayName?: string;
        handle?: string | null;
      };
    }
  | { type: "set_account_status"; accountId: string; status: AccountStatus }
  | {
      type: "toggle_checklist_item";
      accountId: string;
      checklistItemId: string;
      done?: boolean;
    }
  | { type: "regenerate_setup_kit"; accountId: string }
  | { type: "mark_ready_for_planning"; accountId: string };

const actor = "petro@helperg.com";

export function reducer(state: SignalState, action: SignalAction): SignalState {
  switch (action.type) {
    case "approve":
      return mutateItem(state, action.itemId, (it) => ({ ...it, status: "approved" }), {
        action: "approve",
      });

    case "approve_all_low_risk": {
      const updated = state.items.map((it) =>
        it.status === "pending_approval" && it.risk.level === "low"
          ? { ...it, status: "approved" as const }
          : it,
      );
      const events = state.items
        .filter(
          (it) => it.status === "pending_approval" && it.risk.level === "low",
        )
        .map((it) => buildEvent(it.id, "approve", "Bulk-approved as low risk."));
      return rescoreAndMeta({
        ...state,
        items: updated,
        approvalEvents: [...state.approvalEvents, ...events],
      });
    }

    case "reject":
      return mutateItem(
        state,
        action.itemId,
        (it) => ({ ...it, status: "rejected" }),
        { action: "reject", note: action.reason },
      );

    case "delay":
      return mutateItem(
        state,
        action.itemId,
        (it) => applyDelay(it, action.hours ?? 24),
        { action: "delay", note: `Delayed by ${action.hours ?? 24}h.` },
      );

    case "remove_link":
      return mutateItem(
        state,
        action.itemId,
        (it) => removeLink(it),
        { action: "remove_link" },
      );

    case "rewrite_softer":
      return mutateItem(
        state,
        action.itemId,
        (it) => rewriteSofter(it),
        { action: "rewrite_softer" },
      );

    case "convert_to_comment":
      return mutateItem(
        state,
        action.itemId,
        (it) => convertToComment(it),
        { action: "convert_to_comment" },
      );

    case "save_to_backlog": {
      const item = state.items.find((i) => i.id === action.itemId);
      if (!item) return state;
      const bk = toBacklog(
        item,
        action.reason ??
          "Moved to backlog to protect this week's cadence.",
      );
      const items = state.items.map((i) =>
        i.id === action.itemId ? { ...i, status: "backlog" as const } : i,
      );
      const events = [
        ...state.approvalEvents,
        buildEvent(action.itemId, "save_to_backlog", bk.reason),
      ];
      return rescoreAndMeta({
        ...state,
        items,
        backlog: [...state.backlog, bk],
        approvalEvents: events,
      });
    }

    case "pause":
      return mutateItem(
        state,
        action.itemId,
        (it) => ({ ...it, status: "paused" }),
        { action: "delay", note: "Paused by operator." },
      );

    case "resume":
      return mutateItem(
        state,
        action.itemId,
        (it) =>
          it.status === "paused" ? { ...it, status: "pending_approval" } : it,
        { action: "approve", note: "Resumed for review." },
      );

    case "duplicate_next_week": {
      const item = state.items.find((i) => i.id === action.itemId);
      if (!item) return state;
      const cloneTime =
        new Date(item.scheduledFor).getTime() + 7 * 24 * 60 * 60 * 1000;
      const clone: WeeklyPlanItem = {
        ...item,
        id: `${item.id}_dup_${Date.now().toString(36)}`,
        status: "draft",
        scheduledFor: new Date(cloneTime).toISOString(),
      };
      return rescoreAndMeta({
        ...state,
        items: [...state.items, clone],
        approvalEvents: [
          ...state.approvalEvents,
          buildEvent(item.id, "approve", "Duplicated into next week."),
        ],
      });
    }

    case "restore_from_backlog": {
      const bk = state.backlog.find((b) => b.id === action.backlogId);
      if (!bk) return state;
      const restored = fromBacklog(bk, state.plan.id, state.plan.weekStartIso);
      const distributed = redistributeAll(
        [...state.items.filter((i) => i.status !== "backlog"), restored],
        state.plan.weekStartIso,
      );
      const remainingBacklog = state.backlog.filter(
        (b) => b.id !== action.backlogId,
      );
      const itemsWithBacklog = [
        ...distributed.items,
        ...state.items.filter((i) => i.status === "backlog"),
      ];
      return rescoreAndMeta({
        ...state,
        items: itemsWithBacklog,
        backlog: remainingBacklog,
        lastMoves: distributed.moves,
      });
    }

    case "redistribute": {
      const distributed = redistributeAll(
        state.items.filter((i) => i.status !== "backlog"),
        state.plan.weekStartIso,
      );
      const backloggedItems = state.items.filter(
        (i) => i.status === "backlog",
      );
      return rescoreAndMeta({
        ...state,
        items: [...distributed.items, ...backloggedItems],
        lastMoves: distributed.moves,
      });
    }

    case "create_account": {
      const product = state.productsById[action.input.productId];
      if (!product) return state;
      if (state.accountsById[action.input.id]) return state;
      const now = new Date().toISOString();
      const id = action.input.id;
      const kit = buildSetupKit({
        platform: action.input.platform,
        product,
        role: action.input.role,
        existingHandle: action.input.handle ?? null,
        generatedAt: now,
      });
      const displayName =
        action.input.displayName?.trim() ||
        kit.displayNameSuggestions[0] ||
        `${product.name} ${action.input.role}`;
      const account: GrowthAccount = {
        id,
        platform: action.input.platform,
        productId: action.input.productId,
        role: action.input.role,
        handle: action.input.handle ?? null,
        displayName,
        status: "planned",
        readinessScore: computeReadinessForKit(kit.checklist),
        oauthConnected: false,
        setup: kit,
        createdAt: now,
        lastActivityAt: null,
      };
      return rescoreAndMeta({
        ...state,
        accountsById: { ...state.accountsById, [account.id]: account },
      });
    }

    case "set_account_status": {
      const account = state.accountsById[action.accountId];
      if (!account) return state;
      const next: GrowthAccount = { ...account, status: action.status };
      return rescoreAndMeta({
        ...state,
        accountsById: { ...state.accountsById, [account.id]: next },
      });
    }

    case "toggle_checklist_item": {
      const account = state.accountsById[action.accountId];
      if (!account) return state;
      const checklist = account.setup.checklist.map((c) =>
        c.id === action.checklistItemId
          ? { ...c, done: action.done ?? !c.done }
          : c,
      );
      const next: GrowthAccount = {
        ...account,
        setup: { ...account.setup, checklist },
        readinessScore: computeReadinessForKit(checklist),
      };
      return rescoreAndMeta({
        ...state,
        accountsById: { ...state.accountsById, [account.id]: next },
      });
    }

    case "regenerate_setup_kit": {
      const account = state.accountsById[action.accountId];
      if (!account) return state;
      const product = state.productsById[account.productId];
      if (!product) return state;
      const fresh = buildSetupKit({
        platform: account.platform,
        product,
        role: account.role,
        existingHandle: account.handle,
        generatedAt: new Date().toISOString(),
      });
      const mergedChecklist = fresh.checklist.map((c) => {
        const existing = account.setup.checklist.find((p) => p.id === c.id);
        return existing ? { ...c, done: existing.done } : c;
      });
      const next: GrowthAccount = {
        ...account,
        setup: { ...fresh, checklist: mergedChecklist },
        readinessScore: computeReadinessForKit(mergedChecklist),
      };
      return rescoreAndMeta({
        ...state,
        accountsById: { ...state.accountsById, [account.id]: next },
      });
    }

    case "mark_ready_for_planning": {
      const account = state.accountsById[action.accountId];
      if (!account) return state;
      const checklist = account.setup.checklist.map((c) =>
        c.id === "ready_for_planning" ? { ...c, done: true } : c,
      );
      const nextStatus: AccountStatus =
        account.status === "warming" || account.status === "active"
          ? account.status
          : account.oauthConnected
            ? "connected"
            : "ready_to_connect";
      const next: GrowthAccount = {
        ...account,
        setup: { ...account.setup, checklist },
        status: nextStatus,
        readinessScore: computeReadinessForKit(checklist),
      };
      return rescoreAndMeta({
        ...state,
        accountsById: { ...state.accountsById, [account.id]: next },
      });
    }

    default:
      return state;
  }
}

function computeReadinessForKit(checklist: GrowthAccount["setup"]["checklist"]): number {
  return computeReadiness({
    setup: { checklist },
  } as GrowthAccount);
}

function mutateItem(
  state: SignalState,
  itemId: string,
  fn: (item: WeeklyPlanItem) => WeeklyPlanItem,
  event: { action: ApprovalEvent["action"]; note?: string },
): SignalState {
  let touched = false;
  const items = state.items.map((it) => {
    if (it.id !== itemId) return it;
    touched = true;
    return fn(it);
  });
  if (!touched) return state;
  return rescoreAndMeta({
    ...state,
    items,
    approvalEvents: [
      ...state.approvalEvents,
      buildEvent(itemId, event.action, event.note),
    ],
  });
}

function rescoreAndMeta(state: SignalState): SignalState {
  const rescored = scoreAllItems(
    state.items,
    state.accountsById,
    state.productsById,
  );
  return {
    ...state,
    items: rescored,
    plan: planMeta(state.plan, rescored),
  };
}

function buildEvent(
  itemId: string,
  action: ApprovalEvent["action"],
  note?: string,
): ApprovalEvent {
  return {
    id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    planItemId: itemId,
    action,
    actorEmail: actor,
    occurredAt: new Date().toISOString(),
    note,
  };
}

export function initialState(seed: Omit<SignalState, "lastMoves" | "approvalEvents"> & {
  approvalEvents?: ApprovalEvent[];
}): SignalState {
  const items = scoreAllItems(
    seed.items,
    seed.accountsById,
    seed.productsById,
  );
  return {
    plan: planMeta(seed.plan, items),
    items,
    backlog: seed.backlog,
    accountsById: seed.accountsById,
    productsById: seed.productsById,
    approvalEvents: seed.approvalEvents ?? [],
    lastMoves: [],
  };
}
