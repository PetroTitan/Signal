/**
 * Human-readable policy text for the weekly operating contract. Mirrors
 * the long-form description in docs/contracts/weekly-operating-contract.md
 * so the /weekly-contracts UI and the MCP settings page show the same
 * boundary.
 *
 * These are intentionally tight: Phase E1 does *not* unlock anything
 * the user did not pre-grant. The contract is the envelope, not a key.
 */

export const WEEKLY_CONTRACT_POLICY_GRANTED = [
  "Publish the scheduled posts and comments listed in the weekly plan.",
  "Skip or rotate to backlog plan items that no longer fit.",
  "Send engagement signals (likes / saves / follow-ups) on approved accounts.",
  "Open a PR for review (Claude / Codex) on the listed scope.",
] as const;

export const WEEKLY_CONTRACT_POLICY_RESTRICTED = [
  "Only within the weekly window and the per-day cadence ceiling.",
  "Only on the accounts and products explicitly in scope.",
  "Only on the platforms explicitly in scope.",
  "Only at risk level ≤ the contract ceiling.",
  "Only within the execution windows you defined.",
  "If anything fails, the contract auto-pauses until you reapprove.",
] as const;

export const WEEKLY_CONTRACT_POLICY_NEVER_GRANTED = [
  "Create new social accounts.",
  "Log into platforms through browser automation.",
  "Store passwords, cookies, session tokens, 2FA codes, or recovery codes.",
  "Bypass platform safety systems (no anti-detect, no fingerprint spoofing).",
  "Run AI freeform execution that hasn't been pre-listed as an action type.",
  "Touch billing or payment configuration.",
] as const;

/**
 * The contract is intentionally a *narrow* envelope. We never let the
 * runner widen it implicitly. To grant more, the operator must edit and
 * re-approve.
 */
export const WEEKLY_CONTRACT_ENVELOPE_RULES = [
  "Approval is per workspace, per week.",
  "Only one contract is `active` at a time per workspace.",
  "Activating a contract automatically expires the previous one.",
  "Any unhandled action type, account, product, or platform is a hard_block.",
  "Demo workspaces never authorize execution.",
] as const;
