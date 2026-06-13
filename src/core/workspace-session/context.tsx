"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Workspace } from "@/repositories/workspace-repository";
import type { WorkspaceSettings } from "@/repositories/settings-repository";

export interface WorkspaceSessionUser {
  id: string;
  email: string | null;
}

export interface WorkspaceSessionValue {
  user: WorkspaceSessionUser;
  workspace: Workspace;
  settings: WorkspaceSettings | null;
  role: "owner" | "admin" | "editor" | "reviewer" | "viewer";
  /** Phase C2 — unread notifications for the sidebar badge. Refreshes
   *  on navigation (the app layout is dynamic). */
  unreadNotifications: number;
}

const WorkspaceSessionContext = createContext<WorkspaceSessionValue | null>(
  null,
);

export function WorkspaceSessionProvider({
  value,
  children,
}: {
  value: WorkspaceSessionValue;
  children: ReactNode;
}) {
  return (
    <WorkspaceSessionContext.Provider value={value}>
      {children}
    </WorkspaceSessionContext.Provider>
  );
}

export function useWorkspaceSession(): WorkspaceSessionValue {
  const ctx = useContext(WorkspaceSessionContext);
  if (!ctx) {
    throw new Error(
      "useWorkspaceSession must be used inside an authenticated layout.",
    );
  }
  return ctx;
}

export function useMaybeWorkspaceSession(): WorkspaceSessionValue | null {
  return useContext(WorkspaceSessionContext);
}
