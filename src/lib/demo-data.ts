"use client";

import { useDemoMode } from "@/core/demo-mode";

export function useDemoData<T>(real: T[], fallback: T[] = []): T[] {
  const { demoMode } = useDemoMode();
  return demoMode ? real : fallback;
}

export function useIsDemo(): boolean {
  return useDemoMode().demoMode;
}
