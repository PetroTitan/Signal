import type { BlueskyCampaignStatus } from "@/lib/supabase/types";

/**
 * Statuses an operator may deliberately move back to active.
 *
 * A failed or reauthorization-blocked campaign retains the same durable
 * queue and same local-day run. Resuming must never create a replacement
 * run or reset its counters.
 */
export const RESUMABLE_CAMPAIGN_STATUSES = [
  "draft",
  "paused",
  "reauthorization_required",
  "failed",
] as const satisfies readonly BlueskyCampaignStatus[];

export function isResumableCampaignStatus(
  status: BlueskyCampaignStatus,
): status is (typeof RESUMABLE_CAMPAIGN_STATUSES)[number] {
  return (RESUMABLE_CAMPAIGN_STATUSES as readonly BlueskyCampaignStatus[]).includes(
    status,
  );
}

/** Internal dispatcher failures are not Bluesky verdicts. */
export function describeFailedCampaign(input: {
  errorCode: string | null;
  errorMessage: string | null;
}): string {
  const detail = input.errorMessage?.trim().replace(/[.!?]+$/, "") ?? "";
  if (input.errorCode === "dispatch_error") {
    return `Signal's campaign worker stopped on an internal dispatch error${
      detail ? `: ${detail}` : ""
    }. Review and resume, or cancel.`;
  }
  return `Bluesky returned a failure Signal does not recognise as temporary${
    detail ? `: ${detail}` : ""
  }. Review and resume, or cancel.`;
}
