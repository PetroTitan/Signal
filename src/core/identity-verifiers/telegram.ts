/**
 * Telegram identity verifier.
 *
 * Telegram is the only platform where the credential is workspace-
 * level (one bot token shared by the workspace) and the identity is
 * per-target (one channel, group, or supergroup). Verification
 * confirms three things:
 *
 *   1. The bot token authenticates (getMe → bot.id, bot.username).
 *   2. The target resolves (getChat → chat.id, chat.type,
 *      chat.username, chat.title).
 *   3. The bot has the right relationship to the target:
 *        - channel: bot must be administrator/creator AND
 *          can_post_messages !== false.
 *        - group/supergroup: bot must be member/administrator/creator,
 *          NOT left/kicked/restricted-without-send. When Telegram
 *          exposes `can_send_messages`, false fails the check.
 *
 * On success, the connection row stores:
 *   - provider_account_id = canonical chat.id (string)
 *   - handle              = canonical chat.username when public,
 *                            else falls back to the operator-declared
 *                            handle so the row stays human-readable
 *   - metadata.telegram_target_type   = "channel" | "group" | "supergroup"
 *   - metadata.telegram_target_label  = chat.title (preferred) or
 *                                        @chat.username
 *   - metadata.telegram_verified_at   = ISO timestamp
 *   - metadata.telegram_can_post      = true (set only after the
 *                                        per-type permission check
 *                                        passes; never set true if
 *                                        verification failed)
 *
 * The bot token is NOT stored per-identity — it stays on the workspace
 * env var; the per-identity row carries only the target binding.
 *
 * Telegram Bot API:
 *   https://api.telegram.org/bot<TOKEN>/getMe
 *   https://api.telegram.org/bot<TOKEN>/getChat?chat_id=...
 *   https://api.telegram.org/bot<TOKEN>/getChatMember?chat_id=...&user_id=...
 *
 *   Success shape: { ok: true, result: {...} }
 *   Failure shape: { ok: false, error_code: number, description: string }
 *
 * Security posture:
 *   - The bot token is read from the workspace env once and used only
 *     as a Bearer-style path segment of the Telegram URL. It NEVER
 *     appears in returned error messages, response bodies, log lines,
 *     or persisted metadata.
 *   - Defensive: every provider-supplied string is run through
 *     `redactToken` before being surfaced.
 *
 * Pure function. No I/O outside the injected `fetchImpl`.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * Telegram channel/group public @username: 5-32 chars total, ASCII
 * letters, digits, underscores. Must start with a letter and end
 * with a letter or digit. The leading @ is stripped before
 * validation.
 */
const TELEGRAM_USERNAME_RE = /^[a-z][a-z0-9_]{3,30}[a-z0-9]$/;

/**
 * Telegram numeric chat id (private + supergroups + channels).
 * Public groups have negative ids; supergroups + channels are
 * `-100...` (15 digits total). Private user ids would be positive
 * but the bot never publishes to a user — we accept either sign so
 * a typo in the leading minus doesn't surface as a different error.
 */
const TELEGRAM_NUMERIC_CHAT_ID_RE = /^-?\d{6,16}$/;

export type TelegramTargetType = "channel" | "group" | "supergroup";

const TELEGRAM_TARGET_TYPES: ReadonlyArray<TelegramTargetType> = [
  "channel",
  "group",
  "supergroup",
];

export function isTelegramTargetType(
  value: string | null | undefined,
): value is TelegramTargetType {
  return (
    typeof value === "string" &&
    (TELEGRAM_TARGET_TYPES as ReadonlyArray<string>).includes(value)
  );
}

export interface TelegramVerifierInput {
  identityId: string;
  workspaceId: string;
  /** Identity's declared Telegram handle (e.g. "@webmasterid").
   *  Used as the default `target` if the caller doesn't pass one. */
  declaredHandle: string;
  /**
   * Operator-declared target type. Defaults to "channel" so legacy
   * callers (existing channel verify flows that don't pass this
   * field) keep their previous behavior verbatim.
   */
  targetType?: TelegramTargetType;
  /**
   * Optional explicit chat target the operator typed into the Manage
   * panel. Accepts:
   *   - `@username` (public channels/groups/supergroups)
   *   - numeric chat id like `-1001234567890` (private supergroups/
   *     channels) or `-12345` (small private groups)
   * When omitted, the verifier falls back to `declaredHandle`. The
   * canonical chat id resolved from Telegram always wins for
   * persistence (we never store the operator-typed string verbatim
   * as the chat id).
   */
  target?: string | null;
  /**
   * Workspace bot token (from process.env.TELEGRAM_BOT_TOKEN). The
   * route loads this and passes it in; the verifier never reads env
   * directly.
   */
  botToken: string;
  /** Optional fetch impl for tests. */
  fetchImpl?: typeof fetch;
}

export type TelegramVerifierErrorCode =
  | "handle_invalid"
  | "target_invalid"
  | "target_type_invalid"
  | "credentials_missing"
  | "bot_not_admin"
  | "bot_not_member"
  | "bot_cannot_send"
  | "chat_not_found"
  | "chat_type_mismatch"
  | "provider_error"
  | "network_error";

export interface TelegramVerifierConnected {
  outcome: "connected";
  /** chat.id (numeric, but Telegram returns it as either number or
   *  string for channels — we always cast to string for storage). */
  providerAccountId: string;
  /** Canonical channel username (lowercased, no leading @) when the
   *  target is public; falls back to the operator-declared handle
   *  (normalized) for private targets. */
  authenticatedHandle: string;
  /** Resolved target type from Telegram (`chat.type`). May be
   *  "channel", "group", or "supergroup". */
  targetType: TelegramTargetType;
  /** Operator-facing label. Telegram's chat.title when present;
   *  otherwise `@username`. Never includes the bot token or any
   *  secret-shaped value. */
  targetLabel: string;
  /** True when the per-type permission check passed (channels:
   *  admin + can_post_messages; groups: member or above + can-send).
   *  Always true on the `connected` outcome — included for callers
   *  that want to persist it explicitly. */
  canPost: true;
}

export interface TelegramVerifierMismatched {
  outcome: "mismatched";
  declaredHandle: string;
  authenticatedHandle: string;
  providerAccountId: string;
}

export interface TelegramVerifierError {
  outcome: "error";
  code: TelegramVerifierErrorCode;
  message: string;
}

export type TelegramVerifierResult =
  | TelegramVerifierConnected
  | TelegramVerifierMismatched
  | TelegramVerifierError;

export function normalizeTelegramHandle(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase().replace(/^@/, "");
  return trimmed.length === 0 ? null : trimmed;
}

export function isValidTelegramHandle(handle: string): boolean {
  return TELEGRAM_USERNAME_RE.test(handle);
}

/**
 * True when `raw` looks like a Telegram numeric chat id (e.g.
 * `-1001234567890`). Pure shape check; the verifier still calls
 * Telegram to confirm the chat exists and the bot can access it.
 */
export function isTelegramNumericChatId(raw: string): boolean {
  return TELEGRAM_NUMERIC_CHAT_ID_RE.test(raw.trim());
}

/**
 * Parse the operator-supplied target into the value the Telegram
 * `chat_id` query parameter accepts. Returns null when the input
 * shape is invalid (caller surfaces target_invalid).
 *
 * Accepts:
 *   - "@handle" / "handle"  → "@handle" (after normalization)
 *   - "-1001234567890"      → "-1001234567890" (numeric)
 *
 * Pure.
 */
export function parseTelegramTarget(
  raw: string | null | undefined,
):
  | { kind: "handle"; chatIdParam: string; normalizedHandle: string }
  | { kind: "numeric"; chatIdParam: string }
  | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (isTelegramNumericChatId(trimmed)) {
    return { kind: "numeric", chatIdParam: trimmed };
  }
  const normalized = normalizeTelegramHandle(trimmed);
  if (!normalized || !isValidTelegramHandle(normalized)) return null;
  return {
    kind: "handle",
    chatIdParam: `@${normalized}`,
    normalizedHandle: normalized,
  };
}

/**
 * Build a Telegram API URL. Keeps the bot token confined to this
 * single function so every other surface in the module operates on
 * already-built URLs and can't accidentally leak the token by
 * substring matching.
 */
function buildUrl(
  botToken: string,
  method: string,
  params?: Record<string, string | number>,
): string {
  const base = `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;
  if (!params || Object.keys(params).length === 0) return base;
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) query.set(k, String(v));
  return `${base}?${query.toString()}`;
}

/**
 * Redact a string so any occurrence of the bot token is replaced
 * with "<redacted>". Defensive: even though Telegram's error
 * `description` field shouldn't echo the token, callers should run
 * any provider-supplied string through this before surfacing it to
 * the operator.
 */
function redactToken(s: string, botToken: string): string {
  if (!botToken || !s) return s;
  return s.split(botToken).join("<redacted>");
}

export async function verifyTelegramIdentity(
  input: TelegramVerifierInput,
): Promise<TelegramVerifierResult> {
  // ── Input validation ───────────────────────────────────────────
  //
  // Default to "channel" when the caller omits target_type — this is
  // the back-compat path for routes that haven't been updated to
  // surface the new selector yet (existing UI continues to verify
  // channels exactly as before).
  const targetType: TelegramTargetType = input.targetType ?? "channel";
  if (!isTelegramTargetType(targetType)) {
    return {
      outcome: "error",
      code: "target_type_invalid",
      message: `target_type must be one of: channel, group, supergroup (got "${input.targetType}").`,
    };
  }
  const declared = normalizeTelegramHandle(input.declaredHandle);
  if (!declared) {
    return {
      outcome: "error",
      code: "handle_invalid",
      message:
        "Identity has no declared Telegram handle. Set the handle (e.g. @webmasterid) on the identity row before verifying.",
    };
  }
  // The handle on growth_accounts must still look like a Telegram
  // @username — that's the identity's display label. Numeric private
  // chat ids belong on the `target` input, not on the identity row.
  if (!isValidTelegramHandle(declared)) {
    return {
      outcome: "error",
      code: "handle_invalid",
      message: `Handle "${input.declaredHandle}" is not a valid Telegram username (5-32 chars, must start with a letter).`,
    };
  }
  // The `target` input — when supplied — must parse to either a
  // public @username or a numeric chat id. When omitted, fall back
  // to the declared handle.
  const targetRaw =
    typeof input.target === "string" && input.target.trim().length > 0
      ? input.target
      : input.declaredHandle;
  const parsedTarget = parseTelegramTarget(targetRaw);
  if (!parsedTarget) {
    return {
      outcome: "error",
      code: "target_invalid",
      message: `target "${input.target ?? input.declaredHandle}" must be a Telegram @username or a numeric chat id like -1001234567890.`,
    };
  }
  if (typeof input.botToken !== "string" || input.botToken.trim().length === 0) {
    return {
      outcome: "error",
      code: "credentials_missing",
      message:
        "Server is not configured with TELEGRAM_BOT_TOKEN. Ask an administrator to configure the workspace bot and redeploy.",
    };
  }

  const doFetch = input.fetchImpl ?? fetch;

  // ── Step 1: getMe → bot's user_id ──────────────────────────────
  let botUserId: number;
  try {
    const res = await doFetch(buildUrl(input.botToken, "getMe"));
    if (res.status === 401) {
      return {
        outcome: "error",
        code: "credentials_missing",
        message:
          "Telegram rejected the workspace bot token. Ask an administrator to check TELEGRAM_BOT_TOKEN and redeploy.",
      };
    }
    if (!res.ok) {
      return {
        outcome: "error",
        code: "provider_error",
        message: `Telegram getMe failed: HTTP ${res.status}.`,
      };
    }
    const body = (await safeJson(res)) ?? {};
    const result = body.result as Record<string, unknown> | undefined;
    if (body.ok !== true || typeof result?.id !== "number") {
      return {
        outcome: "error",
        code: "provider_error",
        message:
          "Telegram getMe returned an unexpected response shape (missing result.id).",
      };
    }
    botUserId = result.id;
  } catch (err) {
    return {
      outcome: "error",
      code: "network_error",
      message: `Network error reaching Telegram: ${redactToken((err as Error).message ?? "unknown", input.botToken)}.`,
    };
  }

  // ── Step 2: getChat → target info ──────────────────────────────
  let chatId: string;
  let chatType: string;
  let chatTitle: string | null = null;
  let chatUsernameFromTelegram: string | null = null;
  try {
    const res = await doFetch(
      buildUrl(input.botToken, "getChat", {
        chat_id: parsedTarget.chatIdParam,
      }),
    );
    if (!res.ok && res.status !== 400) {
      return {
        outcome: "error",
        code: "provider_error",
        message: `Telegram getChat failed: HTTP ${res.status}.`,
      };
    }
    const body = (await safeJson(res)) ?? {};
    if (body.ok !== true) {
      const description =
        typeof body.description === "string" ? body.description : "";
      const desc = description.toLowerCase();
      if (desc.includes("not found") || desc.includes("chat not found")) {
        return {
          outcome: "error",
          code: "chat_not_found",
          message: `Telegram target ${parsedTarget.chatIdParam} not found or not accessible to this bot.`,
        };
      }
      return {
        outcome: "error",
        code: "provider_error",
        message: `Telegram getChat returned an error (${redactToken(description, input.botToken) || "unknown"}).`,
      };
    }
    const result = body.result as Record<string, unknown> | undefined;
    const idVal = result?.id;
    const typeVal = result?.type;
    if (
      (typeof idVal !== "number" && typeof idVal !== "string") ||
      typeof typeVal !== "string"
    ) {
      return {
        outcome: "error",
        code: "provider_error",
        message:
          "Telegram getChat returned an unexpected response shape (missing result.id or result.type).",
      };
    }
    chatId = String(idVal);
    chatType = typeVal;
    chatTitle = typeof result?.title === "string" ? result.title : null;
    chatUsernameFromTelegram =
      typeof result?.username === "string" ? result.username : null;
  } catch (err) {
    return {
      outcome: "error",
      code: "network_error",
      message: `Network error reaching Telegram getChat: ${redactToken((err as Error).message ?? "unknown", input.botToken)}.`,
    };
  }

  // ── Step 3: chat_type validation + handle-match check ──────────
  //
  // Telegram's `chat.type` returns "channel" | "group" | "supergroup"
  // | "private". If the operator declared a different type, refuse
  // — the operator chose the wrong setup flow.
  if (chatType !== targetType) {
    return {
      outcome: "error",
      code: "chat_type_mismatch",
      message: `Telegram says this target is a "${chatType}", but you selected "${targetType}". Use the matching target type, or pick a different target.`,
    };
  }

  // For public targets (those with a Telegram @username) we still
  // compare against the operator-declared handle so a typo doesn't
  // silently bind to the wrong account. For private numeric targets
  // there's no username to compare; we accept the chat as-is.
  if (chatUsernameFromTelegram !== null) {
    const canonicalNormalized = normalizeTelegramHandle(chatUsernameFromTelegram);
    if (!canonicalNormalized || canonicalNormalized !== declared) {
      return {
        outcome: "mismatched",
        declaredHandle: input.declaredHandle,
        authenticatedHandle: chatUsernameFromTelegram,
        providerAccountId: chatId,
      };
    }
  }

  // ── Step 4: getChatMember → bot membership/admin status ────────
  //
  // Channel: must be administrator/creator AND can_post_messages !== false.
  // Group/Supergroup: must be member/administrator/creator AND, if
  //   `can_send_messages` is exposed, must not be false. Status
  //   "left" / "kicked" / a "restricted" without can_send fail with
  //   bot_not_member / bot_cannot_send respectively.
  try {
    const res = await doFetch(
      buildUrl(input.botToken, "getChatMember", {
        chat_id: chatId,
        user_id: botUserId,
      }),
    );
    if (!res.ok && res.status !== 400) {
      return {
        outcome: "error",
        code: "provider_error",
        message: `Telegram getChatMember failed: HTTP ${res.status}.`,
      };
    }
    const body = (await safeJson(res)) ?? {};
    if (body.ok !== true) {
      return {
        outcome: "error",
        code: targetType === "channel" ? "bot_not_admin" : "bot_not_member",
        message:
          targetType === "channel"
            ? "Add the Signal Telegram bot as an admin to this channel, then try again."
            : "Add the Signal Telegram bot to this group, then try again.",
      };
    }
    const result = body.result as Record<string, unknown> | undefined;
    const status = typeof result?.status === "string" ? result.status : "";

    if (targetType === "channel") {
      const canPost = result?.can_post_messages;
      const isAdmin = status === "administrator" || status === "creator";
      const canPublish =
        isAdmin && (canPost === true || canPost === undefined);
      if (!canPublish) {
        return {
          outcome: "error",
          code: "bot_not_admin",
          message:
            "Add the Signal Telegram bot as an admin to this channel, then try again. The bot needs permission to post messages.",
        };
      }
    } else {
      // group / supergroup
      const memberStatuses = new Set([
        "member",
        "administrator",
        "creator",
        "restricted",
      ]);
      if (!memberStatuses.has(status)) {
        // "left" / "kicked" / unknown shape
        return {
          outcome: "error",
          code: "bot_not_member",
          message:
            "The bot is not a member of this group. Add the Signal Telegram bot to the group, then try again.",
        };
      }
      // When Telegram exposes the explicit send-permission flag for
      // restricted members, false fails the check.
      const canSendMessages = result?.can_send_messages;
      if (status === "restricted" && canSendMessages !== true) {
        return {
          outcome: "error",
          code: "bot_cannot_send",
          message:
            "The bot is restricted from sending messages in this group. Adjust its permissions, then try again.",
        };
      }
      if (canSendMessages === false) {
        return {
          outcome: "error",
          code: "bot_cannot_send",
          message:
            "The bot does not have permission to send messages in this group. Allow it to send messages, then try again.",
        };
      }
    }
  } catch (err) {
    return {
      outcome: "error",
      code: "network_error",
      message: `Network error reaching Telegram getChatMember: ${redactToken((err as Error).message ?? "unknown", input.botToken)}.`,
    };
  }

  // ── Step 5: build the connected outcome ────────────────────────
  //
  // For private targets without a Telegram @username, fall back to
  // the operator-declared handle for the connection's `handle`
  // column. The canonical chat.id always wins on
  // provider_account_id.
  const authenticatedHandle =
    chatUsernameFromTelegram !== null
      ? (normalizeTelegramHandle(chatUsernameFromTelegram) ?? declared)
      : declared;
  const targetLabel =
    chatTitle && chatTitle.trim().length > 0
      ? chatTitle.trim()
      : `@${authenticatedHandle}`;

  return {
    outcome: "connected",
    providerAccountId: chatId,
    authenticatedHandle,
    targetType,
    targetLabel,
    canPost: true,
  };
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
