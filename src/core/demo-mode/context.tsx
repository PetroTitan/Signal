"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const STORAGE_KEY = "signal:demo_mode";

interface DemoModeContextValue {
  demoMode: boolean;
  setDemoMode: (value: boolean) => void;
  /**
   * True when demo mode is forced on by the deploy-time environment flag
   * NEXT_PUBLIC_SIGNAL_DEMO_MODE. When forced, the settings toggle is a
   * no-op and the UI should display that to the user.
   */
  forcedByEnv: boolean;
}

const DemoModeContext = createContext<DemoModeContextValue | null>(null);

function envForcesDemo(): boolean {
  const raw = process.env.NEXT_PUBLIC_SIGNAL_DEMO_MODE;
  if (!raw) return false;
  const normalized = raw.toLowerCase().trim();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

export function DemoModeProvider({ children }: { children: ReactNode }) {
  const forcedByEnv = envForcesDemo();
  const [demoMode, setDemoModeState] = useState(forcedByEnv);

  useEffect(() => {
    if (forcedByEnv) return;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "true") setDemoModeState(true);
    } catch {
      // localStorage unavailable; default stays false.
    }
  }, [forcedByEnv]);

  const setDemoMode = useCallback(
    (value: boolean) => {
      if (forcedByEnv) return;
      setDemoModeState(value);
      try {
        window.localStorage.setItem(STORAGE_KEY, value ? "true" : "false");
      } catch {
        // ignore
      }
    },
    [forcedByEnv],
  );

  const value = useMemo(
    () => ({ demoMode, setDemoMode, forcedByEnv }),
    [demoMode, setDemoMode, forcedByEnv],
  );

  return (
    <DemoModeContext.Provider value={value}>
      {children}
    </DemoModeContext.Provider>
  );
}

export function useDemoMode(): DemoModeContextValue {
  const ctx = useContext(DemoModeContext);
  if (!ctx) {
    throw new Error("useDemoMode must be used inside DemoModeProvider.");
  }
  return ctx;
}
