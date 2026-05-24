/**
 * Telegram identity verifier.
 *
 * Telegram is the only platform where the credential is workspace-
 * level (one bot token shared by the workspace) and the identity is
 * per-channel. Verification confirms three things:
 *
 *   1. The bot token authenticates (getMe → bot.id, bot.username).
 *   2. The channel resolves (getChat → chat.id, chat.username).
 *   3. The bot has admin access with permission to post
 *      (getChatMember → status === "administrator" | "creator" with
 *      can_post_messages === true).
 *
 * On success, the connection row stores the chat_id (as
 * provider_account_id) and the canonical channel username (as
 * authenticated_handle). The bot token is NOT stored per-identity —
 * it stays on the workspace env var; the per-identity row carries
 * only the channel binding.
 *
 * Telegram Bot API:
 *   https://api.telegram.org/bot<TOKEN>/getMe
 *   https://api.telegram.org/bot<TOKEN>/getChat?chat_id=@webmasterid
 *   https://api.telegram.org/bot<TOKEN>/getChatMember?chat_id=@..&user_id=<BOT_ID>
 *
 *   Success shape: { ok: true, result: {...} }
 *   Failure shape: { ok: false, error_code: number, description: string }
 *
 * Security posture:
 *   - The bot token is read from the workspace env once and used
 *     only as a Bearer-style path segment of the Telegram URL. It
 *     NEVER appears in error messages, response bodies, or
 *     metadata stored on the connection row.
 *   - All URL constructions go through a small helper that keeps
 *     the token confined to the URL string of the outbound fetch
 *     call (which is the documented API surface).
 *   - Error messages never echo the token. Defensive: even if
 *     Telegram's `description` field somehow contained the token,
 *     we redact it before bubbling up.
 *
 * Pure function. No I/O outside the injected `fetchImpl`.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * Telegram channel @username constraints: 5-32 chars, ASCII letters,
 * digits, underscores. Must start with a letter and end with a
 * letter or digit. Strip the leading @ before validation.
 */
const TELEGRAM_USERNAME_RE = /^[a-z][a-z0-9_]{3,30}[a-z0-9]$/;

export interface TelegramVerifierInput {
  identityId: string;
  workspaceId: string;
  /** Identity's declared channel handle (e.g. "@webmasterid"). */
  declaredHandle: string;
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
  | "credentials_missing"
  | "bot_not_admin"
  | "chat_not_found"
  | "provider_error"
  | "network_error";

export interface TelegramVerifierConnected {
  outcome: "connected";
  /** chat.id (numeric, but Telegram returns it as either number or
   *  string for channels — we always cast to string for storage). */
  providerAccountId: string;
  /** Canonical channel username (lowercased, no leading @). */
  authenticatedHandle: string;
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
  const declared = normalizeTelegramHandle(input.declaredHandle);
  if (!declared) {
    return {
      outcome: "error",
      code: "handle_invalid",
      message:
        "Identity has no declared Telegram channel handle. Set the handle (e.g. @webmasterid) on the identity row before verifying.",
    };
  }
  if (!isValidTelegramHandle(declared)) {
    return {
      outcome: "error",
      code: "handle_invalid",
      message: `Handle "${input.declaredHandle}" is not a valid Telegram channel username (5-32 chars, must start with a letter).`,
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

  // ── Step 2: getChat → channel info ─────────────────────────────
  let chatId: string;
  let canonicalHandle: string;
  try {
    const res = await doFetch(
      buildUrl(input.botToken, "getChat", { chat_id: `@${declared}` }),
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
          message: `Telegram channel @${declared} not found or not accessible to this bot.`,
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
    const usernameVal = result?.username;
    if (
      (typeof idVal !== "number" && typeof idVal !== "string") ||
      typeof usernameVal !== "string"
    ) {
      return {
        outcome: "error",
        code: "provider_error",
        message:
          "Telegram getChat returned an unexpected response shape (missing result.id or result.username).",
      };
    }
    chatId = String(idVal);
    canonicalHandle = usernameVal;
  } catch (err) {
    return {
      outcome: "error",
      code: "network_error",
      message: `Network error reaching Telegram getChat: ${redactToken((err as Error).message ?? "unknown", input.botToken)}.`,
    };
  }

  // ── Step 3: handle match check ─────────────────────────────────
  const canonicalNormalized = normalizeTelegramHandle(canonicalHandle);
  if (!canonicalNormalized || canonicalNormalized !== declared) {
    return {
      outcome: "mismatched",
      declaredHandle: input.declaredHandle,
      authenticatedHandle: canonicalHandle,
      providerAccountId: chatId,
    };
  }

  // ── Step 4: getChatMember → bot admin status ───────────────────
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
        code: "bot_not_admin",
        message:
          "Add the Signal Telegram bot as an admin to this channel, then try again.",
      };
    }
    const result = body.result as Record<string, unknown> | undefined;
    const status = typeof result?.status === "string" ? result.status : "";
    const canPost = result?.can_post_messages;
    const isAdmin = status === "administrator" || status === "creator";
    // Channels require admin status + can_post_messages: true. Groups
    // require admin status (bot posts work without explicit
    // can_post_messages for groups). We require both signals when
    // can_post_messages is present.
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
  } catch (err) {
    return {
      outcome: "error",
      code: "network_error",
      message: `Network error reaching Telegram getChatMember: ${redactToken((err as Error).message ?? "unknown", input.botToken)}.`,
    };
  }

  return {
    outcome: "connected",
    providerAccountId: chatId,
    authenticatedHandle: canonicalNormalized,
  };
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
