/**
 * The structured envelope every evaluation returns. Both the engine and
 * the repository write this shape; the repository persists it into
 * execution_authorizations.
 */

import type {
  ExecutionAuthorizationOutcome,
  ExecutionAuthorizationReasonCode,
  ExecutionAuthorizationSuggestedAction,
} from "./approval-contract-types";

export interface AuthorizationResult {
  authorized: boolean;
  outcome: ExecutionAuthorizationOutcome;
  reasonCode: ExecutionAuthorizationReasonCode;
  reasonDetail: string | null;
  severity: "allow" | "soft_block" | "hard_block";
  suggestedAction: ExecutionAuthorizationSuggestedAction | null;
  shouldBacklog: boolean;
  shouldPause: boolean;
}

export const ALLOWED_RESULT: AuthorizationResult = {
  authorized: true,
  outcome: "allowed",
  reasonCode: "allowed",
  reasonDetail: null,
  severity: "allow",
  suggestedAction: "proceed",
  shouldBacklog: false,
  shouldPause: false,
};

interface DenialOptions {
  reasonDetail?: string;
  severity: "soft_block" | "hard_block";
  suggestedAction?: ExecutionAuthorizationSuggestedAction;
  shouldBacklog?: boolean;
  shouldPause?: boolean;
}

export function deny(
  reasonCode: ExecutionAuthorizationReasonCode,
  opts: DenialOptions,
): AuthorizationResult {
  return {
    authorized: false,
    outcome: opts.severity,
    reasonCode,
    reasonDetail: opts.reasonDetail ?? null,
    severity: opts.severity,
    suggestedAction: opts.suggestedAction ?? null,
    shouldBacklog: opts.shouldBacklog ?? false,
    shouldPause: opts.shouldPause ?? false,
  };
}

export function isAllow(r: AuthorizationResult): boolean {
  return r.severity === "allow";
}

export function isHardBlock(r: AuthorizationResult): boolean {
  return r.severity === "hard_block";
}

export function isSoftBlock(r: AuthorizationResult): boolean {
  return r.severity === "soft_block";
}
