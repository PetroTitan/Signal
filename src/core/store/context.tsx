"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import type {
  ApprovalEvent,
  BacklogItem,
  GrowthAccount,
  ProductProfile,
  WeeklyPlan,
  WeeklyPlanItem,
} from "@/types";
import { initialState, reducer, type SignalAction, type SignalState } from "./reducer";

interface SignalContextValue {
  state: SignalState;
  dispatch: (action: SignalAction) => void;
  itemsByStatus: Record<WeeklyPlanItem["status"], WeeklyPlanItem[]>;
}

const SignalContext = createContext<SignalContextValue | null>(null);

export interface SignalProviderProps {
  children: ReactNode;
  seed: {
    plan: WeeklyPlan;
    items: WeeklyPlanItem[];
    backlog: BacklogItem[];
    accounts: GrowthAccount[];
    products: ProductProfile[];
    approvalEvents?: ApprovalEvent[];
  };
}

export function SignalProvider({ children, seed }: SignalProviderProps) {
  const [state, dispatch] = useReducer(
    reducer,
    initialState({
      plan: seed.plan,
      items: seed.items,
      backlog: seed.backlog,
      accountsById: indexById(seed.accounts),
      productsById: indexById(seed.products),
      approvalEvents: seed.approvalEvents,
    }),
  );

  const itemsByStatus = useMemo(() => groupByStatus(state.items), [state.items]);

  const value = useMemo(
    () => ({ state, dispatch, itemsByStatus }),
    [state, itemsByStatus],
  );

  return (
    <SignalContext.Provider value={value}>{children}</SignalContext.Provider>
  );
}

export function useSignal(): SignalContextValue {
  const ctx = useContext(SignalContext);
  if (!ctx) {
    throw new Error("useSignal must be used inside SignalProvider.");
  }
  return ctx;
}

export function useDispatch() {
  return useSignal().dispatch;
}

export function useApprovalActions() {
  const dispatch = useDispatch();
  return {
    approve: useCallback(
      (itemId: string) => dispatch({ type: "approve", itemId }),
      [dispatch],
    ),
    reject: useCallback(
      (itemId: string, reason?: string) =>
        dispatch({ type: "reject", itemId, reason }),
      [dispatch],
    ),
    delay: useCallback(
      (itemId: string, hours?: number) =>
        dispatch({ type: "delay", itemId, hours }),
      [dispatch],
    ),
    removeLink: useCallback(
      (itemId: string) => dispatch({ type: "remove_link", itemId }),
      [dispatch],
    ),
    rewriteSofter: useCallback(
      (itemId: string) => dispatch({ type: "rewrite_softer", itemId }),
      [dispatch],
    ),
    convertToComment: useCallback(
      (itemId: string) => dispatch({ type: "convert_to_comment", itemId }),
      [dispatch],
    ),
    saveToBacklog: useCallback(
      (itemId: string, reason?: string) =>
        dispatch({ type: "save_to_backlog", itemId, reason }),
      [dispatch],
    ),
    pause: useCallback(
      (itemId: string) => dispatch({ type: "pause", itemId }),
      [dispatch],
    ),
    resume: useCallback(
      (itemId: string) => dispatch({ type: "resume", itemId }),
      [dispatch],
    ),
    duplicateNextWeek: useCallback(
      (itemId: string) => dispatch({ type: "duplicate_next_week", itemId }),
      [dispatch],
    ),
    approveAllLowRisk: useCallback(
      () => dispatch({ type: "approve_all_low_risk" }),
      [dispatch],
    ),
    redistribute: useCallback(
      () => dispatch({ type: "redistribute" }),
      [dispatch],
    ),
    restoreFromBacklog: useCallback(
      (backlogId: string) =>
        dispatch({ type: "restore_from_backlog", backlogId }),
      [dispatch],
    ),
  };
}

function groupByStatus(items: WeeklyPlanItem[]): Record<WeeklyPlanItem["status"], WeeklyPlanItem[]> {
  const out = {
    draft: [],
    pending_approval: [],
    approved: [],
    rejected: [],
    scheduled: [],
    published: [],
    skipped: [],
    backlog: [],
    paused: [],
  } as Record<WeeklyPlanItem["status"], WeeklyPlanItem[]>;
  for (const it of items) {
    out[it.status].push(it);
  }
  return out;
}

function indexById<T extends { id: string }>(arr: T[]): Record<string, T> {
  return Object.fromEntries(arr.map((a) => [a.id, a]));
}
