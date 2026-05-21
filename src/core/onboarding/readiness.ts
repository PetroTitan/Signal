import type { ChecklistItem, GrowthAccount } from "@/types";

const checklistWeights: Record<string, number> = {
  kit_generated: 5,
  manual_account_created: 20,
  email_verified: 10,
  "2fa_enabled": 10,
  profile_completed: 15,
  first_warmup_planned: 10,
  oauth_connected: 15,
  ready_for_planning: 15,
};

export function computeReadiness(account: GrowthAccount): number {
  const max = Object.values(checklistWeights).reduce((a, b) => a + b, 0);
  const total = account.setup.checklist.reduce((sum, item) => {
    if (!item.done) return sum;
    return sum + (checklistWeights[item.id] ?? 5);
  }, 0);
  return Math.round((total / max) * 100);
}

export function missingSteps(account: GrowthAccount): ChecklistItem[] {
  return account.setup.checklist.filter((c) => !c.done);
}

export function nextBestAction(account: GrowthAccount): string | null {
  const missing = missingSteps(account);
  if (missing.length === 0) {
    return account.status === "active" || account.status === "warming"
      ? null
      : "Mark this account ready for weekly planning.";
  }
  const next = missing[0];
  switch (next.id) {
    case "kit_generated":
      return "Generate the setup kit so you have usernames, bio, and a warm-up plan.";
    case "manual_account_created":
      return "Create the account manually on the platform. Signal will not do this for you.";
    case "email_verified":
      return "Verify the account email on the platform.";
    case "2fa_enabled":
      return "Enable two-factor authentication on the platform.";
    case "profile_completed":
      return "Set the display name, bio, and avatar using the generated kit.";
    case "first_warmup_planned":
      return "Plan the first three warm-up actions from the 14-day plan.";
    case "oauth_connected":
      return "OAuth connection is reserved for when official integrations ship.";
    case "ready_for_planning":
      return "Mark this account as ready for weekly planning.";
    default:
      return `Complete: ${next.label}`;
  }
}

export function safetyRecommendation(account: GrowthAccount): string | null {
  if (account.status === "paused") {
    return "Account is paused. Cadence checks ignore it until resumed.";
  }
  if (account.status === "planned" || account.status === "setup_needed") {
    return "Account is not eligible for the weekly plan. Complete manual setup first.";
  }
  if (account.status === "awaiting_manual_creation") {
    return "Account has not been created on the platform yet. The 14-day warm-up has not started.";
  }
  if (account.status === "warming") {
    return "Warming. Keep tone observational and link-free. Promotional items will be flagged.";
  }
  return null;
}
