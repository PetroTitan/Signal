import type { AccountStatus } from "@/types";
import { ELIGIBLE_FOR_PLANNING } from "@/types";

export function EligibilityBadge({
  status,
  compact = false,
}: {
  status: AccountStatus;
  compact?: boolean;
}) {
  const eligible = ELIGIBLE_FOR_PLANNING.includes(status);
  if (eligible) {
    return (
      <span className="badge-low" title="Eligible for weekly planning">
        {compact ? "Eligible" : "Eligible for planning"}
      </span>
    );
  }
  return (
    <span
      className="badge-medium"
      title="Not eligible for weekly planning"
    >
      {compact ? "Not eligible" : "Not eligible for planning"}
    </span>
  );
}
