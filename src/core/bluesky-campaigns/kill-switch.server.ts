import "server-only";
/**
 * Kill switches.
 *
 * Two layers, because they answer different emergencies:
 *
 *   DEPLOY LEVEL  `BLUESKY_CAMPAIGNS_DISABLED=1` stops every campaign in
 *                 every workspace without touching the database. This is
 *                 the switch for "something is badly wrong and I do not
 *                 want to reason about scope" — it requires a redeploy
 *                 or an env change, which is the point.
 *
 *   WORKSPACE     A row per workspace (global) or per identity. This is
 *                 the switch an operator can throw from the UI in
 *                 seconds, and it survives a redeploy.
 *
 * Both are checked before any provider call. The env switch is checked
 * first and short-circuits, so an incident does not depend on the
 * database being reachable.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { listKillSwitches } from "@/repositories/bluesky-campaign-repository";

export const CAMPAIGNS_DISABLED_ENV = "BLUESKY_CAMPAIGNS_DISABLED";

export interface KillSwitchState {
  engaged: boolean;
  scope: "environment" | "workspace" | "identity" | null;
  reason: string | null;
}

const DISENGAGED: KillSwitchState = {
  engaged: false,
  scope: null,
  reason: null,
};

/** Deploy-level switch. Truthy value engages it. */
export function isGloballyDisabledByEnv(): boolean {
  const raw = process.env[CAMPAIGNS_DISABLED_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Resolve the effective switch for one identity.
 *
 * Order matters: environment, then workspace-global, then identity.
 * The first engaged one wins, and its scope is reported so the UI can
 * say which switch to release.
 */
export async function resolveKillSwitch(input: {
  workspaceId: string;
  operatorAccountId: string;
  db?: SupabaseClient;
}): Promise<KillSwitchState> {
  if (isGloballyDisabledByEnv()) {
    return {
      engaged: true,
      scope: "environment",
      reason: `Campaigns are disabled for this deployment (${CAMPAIGNS_DISABLED_ENV}). No campaign in any workspace will run until it is unset.`,
    };
  }

  let switches;
  try {
    switches = await listKillSwitches(input.workspaceId, input.db);
  } catch {
    // Fail CLOSED. If we cannot read the switches we cannot know that
    // none is engaged, and an unattended system that follows real
    // people should not proceed on an assumption.
    return {
      engaged: true,
      scope: "workspace",
      reason:
        "Could not read the campaign kill switches, so nothing was attempted. This is deliberate: an unattended follow run must not proceed on the assumption that no stop has been requested.",
    };
  }

  const global = switches.find((s) => s.operator_account_id === null && s.engaged);
  if (global) {
    return {
      engaged: true,
      scope: "workspace",
      reason:
        global.reason ??
        "All campaigns in this workspace are stopped by the workspace kill switch.",
    };
  }

  const identity = switches.find(
    (s) => s.operator_account_id === input.operatorAccountId && s.engaged,
  );
  if (identity) {
    return {
      engaged: true,
      scope: "identity",
      reason:
        identity.reason ??
        "Campaigns for this Bluesky identity are stopped by its kill switch.",
    };
  }

  return DISENGAGED;
}
