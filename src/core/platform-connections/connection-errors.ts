export type ConnectionErrorCode =
  | "not_implemented"
  | "platform_unreachable"
  | "scope_denied"
  | "user_cancelled"
  | "expired"
  | "revoked"
  | "rate_limited"
  | "internal";

export interface ConnectionError {
  code: ConnectionErrorCode;
  userMessage: string;
}

const userMessages: Record<ConnectionErrorCode, string> = {
  not_implemented:
    "OAuth integrations are not enabled yet. Signal will never ask for passwords.",
  platform_unreachable: "Couldn't reach the platform. Try again in a minute.",
  scope_denied:
    "You declined a permission Signal needs. You can retry and approve it.",
  user_cancelled: "Connection cancelled.",
  expired: "Connection expired. Reauthorize to continue.",
  revoked: "Connection was revoked.",
  rate_limited: "Too many requests right now. Try again shortly.",
  internal: "Something went wrong on Signal's side.",
};

export function connectionError(code: ConnectionErrorCode): ConnectionError {
  return { code, userMessage: userMessages[code] };
}
