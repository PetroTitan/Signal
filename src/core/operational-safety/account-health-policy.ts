export const ACCOUNT_HEALTH_POLICY = {
  // The single most important number: the share of a week's items that can
  // carry an outbound product link. Keeping this low protects accounts on
  // platforms with low link tolerance (Reddit, X).
  maxDirectLinkRatio: 0.33,
  // Days of intentional silence per platform per week.
  recommendedNoPostDaysPerWeek: 2,
  // Warm-up window before promotional items become safe.
  warmUpDays: 14,
  // Maximum items per account per week before "high velocity" warning.
  highVelocityThreshold: 4,
} as const;

export const ACCOUNT_HEALTH_PRINCIPLES = [
  "Silence is a valid output. Quiet weeks protect long-term presence.",
  "Comments first. Posts and links earn their place over time.",
  "Warm-up before promotion. New accounts publish nothing for two weeks.",
  "Caps before urgency. A weekly cap beats an impulse to publish more.",
  "Skip is a real action. Not every thread is worth participating in.",
];
