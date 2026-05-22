export const CONNECTION_POLICY = {
  // What Signal will never ask for, ever.
  neverAsk: [
    "platform passwords",
    "cookies",
    "session tokens",
    "2FA codes",
    "recovery codes",
    "browser fingerprints",
    "proxy configuration",
  ],
  // The only path to a connection.
  authorizationModel: "official_oauth_only",
  // Whether tokens are stored client-side.
  tokenLocation: "server_only_when_implemented",
  // Whether the founder can revoke at any time.
  revocableByFounder: true,
  // Re-auth requirement on scope change.
  reauthOnScopeChange: true,
  // Where AI runs.
  aiRunsClientSide: false,
  aiRunsServerSide: "when_configured",
} as const;

export const CONNECTION_POLICY_LINES = [
  "Signal will never ask for passwords, cookies, session tokens, 2FA codes, or recovery codes.",
  "Connections happen through official OAuth flows only.",
  "Tokens, when implemented, are stored server-side and never exposed to the browser.",
  "You can revoke any connection at any time.",
  "Scope changes require explicit reauthorization.",
];
