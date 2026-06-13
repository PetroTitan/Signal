"use client";

import { useFormState, useFormStatus } from "react-dom";
import { switchWorkspaceAction } from "./_actions";
import type { ActionResult } from "@/lib/forms/action-result";

const initial: ActionResult = { ok: false, error: "" };

/**
 * C1.5 — workspace switcher. Lists the caller's workspaces and switches
 * the active one via setPrimaryWorkspace (the mechanism getPrimaryWorkspace
 * already follows app-wide), so RLS + primary behavior are preserved.
 */
export interface SwitcherWorkspace {
  id: string;
  name: string;
  role: string;
  isActive: boolean;
}

function SwitchButton({ active }: { active: boolean }) {
  const { pending } = useFormStatus();
  if (active) {
    return <span className="text-[11px] text-emerald-700 font-medium">Active</span>;
  }
  return (
    <button type="submit" disabled={pending} className="btn text-[11px] disabled:opacity-50">
      {pending ? "Switching…" : "Switch"}
    </button>
  );
}

export function WorkspaceSwitcher({ workspaces }: { workspaces: SwitcherWorkspace[] }) {
  if (workspaces.length <= 1) {
    return (
      <p className="text-xs text-ink-500">
        You belong to one workspace. Accept an invitation to join another.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-ink-100">
      {workspaces.map((w) => (
        <SwitcherRow key={w.id} workspace={w} />
      ))}
    </ul>
  );
}

function SwitcherRow({ workspace: w }: { workspace: SwitcherWorkspace }) {
  const [, action] = useFormState(switchWorkspaceAction, initial);
  return (
    <li className="py-2 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <span className="text-sm text-ink-900 truncate">{w.name}</span>
        <span className="ml-2 text-[11px] text-ink-500">{w.role}</span>
      </div>
      <form action={action}>
        <input type="hidden" name="workspace_id" value={w.id} />
        <SwitchButton active={w.isActive} />
      </form>
    </li>
  );
}
