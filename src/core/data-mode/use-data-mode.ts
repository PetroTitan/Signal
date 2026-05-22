"use client";

import { useMemo } from "react";
import { useDemoMode } from "@/core/demo-mode";
import { useSignal } from "@/core/store";
import { describeDataMode, type DataModeInfo } from "./data-mode";

export interface UseDataModeResult extends DataModeInfo {
  hasProducts: boolean;
  hasAccounts: boolean;
  hasItems: boolean;
  hasBacklog: boolean;
  hasAnyOperationalData: boolean;
  /**
   * True when normal mode should show a real-empty-state instead of any
   * computed UI. False if either demo mode is on or the workspace already has
   * data the user created themselves.
   */
  shouldShowRealEmpty: boolean;
}

/**
 * Single source of truth for "is this page allowed to show operational UI?".
 * Pages should call this hook and branch on `shouldShowRealEmpty` before
 * rendering any computed cards, queues, stats, or recommendations.
 */
export function useDataMode(): UseDataModeResult {
  const { demoMode } = useDemoMode();
  const { state } = useSignal();

  return useMemo(() => {
    const info = describeDataMode(demoMode ? "demo" : "real");
    const hasProducts = Object.keys(state.productsById).length > 0;
    const hasAccounts = Object.keys(state.accountsById).length > 0;
    const hasItems = state.items.length > 0;
    const hasBacklog = state.backlog.length > 0;
    const hasAnyOperationalData = hasProducts || hasAccounts || hasItems || hasBacklog;
    return {
      ...info,
      hasProducts,
      hasAccounts,
      hasItems,
      hasBacklog,
      hasAnyOperationalData,
      shouldShowRealEmpty: info.isReal && !hasAnyOperationalData,
    };
  }, [demoMode, state.accountsById, state.backlog.length, state.items.length, state.productsById]);
}
