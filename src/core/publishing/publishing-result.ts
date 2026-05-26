/**
 * Phase F1 — pure helpers for the publishing outcome envelope.
 */

import type {
  PublishOutcome,
  PublishReasonCode,
  PublishStatus,
} from "./publishing-types";

export function publishOk(input: {
  externalId: string | null;
  externalUrl: string | null;
  reasonDetail?: string | null;
  metadata?: Record<string, unknown>;
}): PublishOutcome {
  return {
    status: "published",
    reasonCode: "ok",
    reasonDetail: input.reasonDetail ?? null,
    externalId: input.externalId,
    externalUrl: input.externalUrl,
    metadata: input.metadata ?? {},
  };
}

export function publishSkip(
  reasonCode: PublishReasonCode,
  reasonDetail: string,
): PublishOutcome {
  return {
    status: "skipped",
    reasonCode,
    reasonDetail,
    externalId: null,
    externalUrl: null,
    metadata: {},
  };
}

export function publishBlocked(
  reasonCode: PublishReasonCode,
  reasonDetail: string,
  metadata: Record<string, unknown> = {},
): PublishOutcome {
  return {
    status: "blocked",
    reasonCode,
    reasonDetail,
    externalId: null,
    externalUrl: null,
    metadata,
  };
}

export function publishFail(
  reasonCode: PublishReasonCode,
  reasonDetail: string,
  metadata: Record<string, unknown> = {},
): PublishOutcome {
  return {
    status: "failed",
    reasonCode,
    reasonDetail,
    externalId: null,
    externalUrl: null,
    metadata,
  };
}

export function publishNotImplemented(platform: string): PublishOutcome {
  return {
    status: "not_implemented",
    reasonCode: "platform_not_supported",
    reasonDetail: `The "${platform}" publisher is not implemented in Phase F1.`,
    externalId: null,
    externalUrl: null,
    metadata: { platform },
  };
}

export function isTerminalSuccess(status: PublishStatus): boolean {
  return status === "published";
}
