/**
 * Pure dry-run executor.
 *
 * Given an authorization result and an item, it returns a structured
 * description of what *would* happen — never calls a real platform.
 * The repository layer persists the result; this module is the brain.
 */

import type { AuthorizationResult } from "@/core/weekly-contract";
import type { WeeklyContractActionType } from "@/core/weekly-contract";
import {
  dryRunActionForAction,
  type DryRunAction,
} from "./execution-types";

export interface DryRunInput {
  workspaceId: string;
  itemId: string;
  actionType: WeeklyContractActionType | string;
  platform: string | null;
  authorization: AuthorizationResult;
}

export type DryRunOutcome =
  | {
      kind: "executed";
      dryRunAction: DryRunAction;
      message: string;
      shouldComplete: true;
      shouldBacklog: false;
      shouldSkip: false;
    }
  | {
      kind: "skipped";
      dryRunAction: DryRunAction;
      message: string;
      shouldComplete: false;
      shouldBacklog: false;
      shouldSkip: true;
    }
  | {
      kind: "backlogged";
      dryRunAction: DryRunAction;
      message: string;
      shouldComplete: false;
      shouldBacklog: true;
      shouldSkip: false;
    }
  | {
      kind: "blocked";
      dryRunAction: null;
      message: string;
      shouldComplete: false;
      shouldBacklog: false;
      shouldSkip: false;
    };

export function dryRunExecute(input: DryRunInput): DryRunOutcome {
  const auth = input.authorization;
  const action =
    isWeeklyContractAction(input.actionType)
      ? dryRunActionForAction(input.actionType)
      : "would_schedule_item";

  if (auth.severity === "hard_block") {
    return {
      kind: "blocked",
      dryRunAction: null,
      message: `Hard block — ${auth.reasonCode}${
        auth.reasonDetail ? `: ${auth.reasonDetail}` : ""
      }. Nothing executed.`,
      shouldComplete: false,
      shouldBacklog: false,
      shouldSkip: false,
    };
  }

  if (auth.severity === "soft_block") {
    if (auth.shouldBacklog) {
      return {
        kind: "backlogged",
        dryRunAction: "would_move_to_backlog",
        message: `Soft block — ${auth.reasonCode}. Dry-run would move this item to the backlog.`,
        shouldComplete: false,
        shouldBacklog: true,
        shouldSkip: false,
      };
    }
    return {
      kind: "skipped",
      dryRunAction: "would_skip_risky_thread",
      message: `Soft block — ${auth.reasonCode}. Dry-run would skip this item.`,
      shouldComplete: false,
      shouldBacklog: false,
      shouldSkip: true,
    };
  }

  // Allowed
  return {
    kind: "executed",
    dryRunAction: action,
    message: `Dry-run: ${action.replace(/_/g, " ")} on ${
      input.platform ?? "no platform"
    }. No external call was made.`,
    shouldComplete: true,
    shouldBacklog: false,
    shouldSkip: false,
  };
}

function isWeeklyContractAction(
  s: string,
): s is WeeklyContractActionType {
  return (
    s === "publish_scheduled_post" ||
    s === "publish_scheduled_comment" ||
    s === "send_engagement_signal" ||
    s === "mark_item_skipped" ||
    s === "rotate_to_backlog" ||
    s === "open_pr_for_review" ||
    s === "request_screenshot_import" ||
    s === "request_profile_suggestion"
  );
}
