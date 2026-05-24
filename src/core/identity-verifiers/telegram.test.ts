import { describe, expect, it } from "vitest";
import {
  isValidTelegramHandle,
  normalizeTelegramHandle,
  verifyTelegramIdentity,
} from "./telegram";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Telegram does THREE network calls (getMe / getChat / getChatMember)
 * in order. The responder picks which response to return by inspecting
 * the URL path — keeps tests declarative without per-step state.
 */
function makeFetch(
  responder: (
    url: string,
    init: RequestInit | undefined,
  ) => { status: number; body: unknown },
  captures?: CapturedCall[],
): typeof fetch {
  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    if (captures) captures.push({ url, init });
    const r = responder(url, init);
    return jsonResponse(r.body, r.status);
  }) as typeof fetch;
}

const BOT_TOKEN = "1234567890:AAH-fake-bot-token-for-tests-xxxxxxxxx";
const BOT_USER_ID = 7654321;

const BASE = {
  identityId: "id-1",
  workspaceId: "ws-1",
  declaredHandle: "webmasterid",
  botToken: BOT_TOKEN,
};

/**
 * Default "happy path" responder. Returns:
 *   - getMe       → { ok: true, result: { id: BOT_USER_ID, is_bot: true, username: "signalbot" } }
 *   - getChat     → { ok: true, result: { id: -1001234567890, username: "webmasterid", type: "channel" } }
 *   - getChatMember → { ok: true, result: { user: {...}, status: "administrator", can_post_messages: true } }
 */
function defaultResponder(url: string): { status: number; body: unknown } {
  // Note: check the more-specific /getChatMember path BEFORE
  // /getChat, since the latter is a substring of the former.
  if (url.includes("/getChatMember")) {
    return {
      status: 200,
      body: {
        ok: true,
        result: {
          user: { id: BOT_USER_ID, is_bot: true, username: "signalbot" },
          status: "administrator",
          can_post_messages: true,
        },
      },
    };
  }
  if (url.includes("/getMe")) {
    return {
      status: 200,
      body: {
        ok: true,
        result: { id: BOT_USER_ID, is_bot: true, username: "signalbot" },
      },
    };
  }
  if (url.includes("/getChat")) {
    return {
      status: 200,
      body: {
        ok: true,
        result: {
          id: -1001234567890,
          username: "webmasterid",
          type: "channel",
          title: "WebmasterID",
        },
      },
    };
  }
  return { status: 404, body: { ok: false, description: "unknown method" } };
}

// =====================================================================
// normalize + validate
// =====================================================================

describe("normalizeTelegramHandle", () => {
  it("lowercases and strips @ + whitespace", () => {
    expect(normalizeTelegramHandle("  @WebmasterID  ")).toBe("webmasterid");
  });
  it("returns null for empty/null/whitespace", () => {
    expect(normalizeTelegramHandle(null)).toBeNull();
    expect(normalizeTelegramHandle(undefined)).toBeNull();
    expect(normalizeTelegramHandle("")).toBeNull();
    expect(normalizeTelegramHandle("   ")).toBeNull();
  });
});

describe("isValidTelegramHandle", () => {
  it("accepts 5-32 chars starting with a letter (alphanumeric + underscore)", () => {
    expect(isValidTelegramHandle("webmasterid")).toBe(true);
    expect(isValidTelegramHandle("a_channel1")).toBe(true);
    expect(isValidTelegramHandle("abcde")).toBe(true); // min 5
  });
  it("rejects too short / too long", () => {
    expect(isValidTelegramHandle("abc")).toBe(false); // 3 chars
    expect(isValidTelegramHandle("abcd")).toBe(false); // 4 chars
    expect(isValidTelegramHandle("a".repeat(33))).toBe(false);
  });
  it("rejects names that don't start with a letter", () => {
    expect(isValidTelegramHandle("1channel")).toBe(false);
    expect(isValidTelegramHandle("_channel")).toBe(false);
  });
  it("rejects names with disallowed chars (uppercase / hyphen / dot / space)", () => {
    expect(isValidTelegramHandle("Bad_Name")).toBe(false);
    expect(isValidTelegramHandle("name-here")).toBe(false);
    expect(isValidTelegramHandle("name.here")).toBe(false);
    expect(isValidTelegramHandle("name here")).toBe(false);
  });
  it("rejects names that end with an underscore", () => {
    expect(isValidTelegramHandle("foobar_")).toBe(false);
  });
});

// =====================================================================
// success
// =====================================================================

describe("verifyTelegramIdentity — success", () => {
  it("returns 'connected' with chat_id + canonical username", async () => {
    const fetchImpl = makeFetch(defaultResponder);
    const result = await verifyTelegramIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("connected");
    if (result.outcome !== "connected") return;
    expect(result.providerAccountId).toBe("-1001234567890");
    expect(result.authenticatedHandle).toBe("webmasterid");
  });

  it("matches handle case-insensitively (declared @WebmasterID, channel webmasterid)", async () => {
    const fetchImpl = makeFetch(defaultResponder);
    const result = await verifyTelegramIdentity({
      ...BASE,
      declaredHandle: "@WebmasterID",
      fetchImpl,
    });
    expect(result.outcome).toBe("connected");
  });

  it("accepts a chat where the bot is 'creator' (also a valid admin role)", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/getChatMember")) {
        return {
          status: 200,
          body: {
            ok: true,
            result: {
              user: { id: BOT_USER_ID, is_bot: true },
              status: "creator",
              // 'creator' may omit can_post_messages — group/channel
              // owners always can post.
            },
          },
        };
      }
      return defaultResponder(url);
    });
    const result = await verifyTelegramIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("connected");
  });

  it("makes exactly 3 calls (getMe, getChat, getChatMember) in order", async () => {
    const captures: CapturedCall[] = [];
    const fetchImpl = makeFetch(defaultResponder, captures);
    await verifyTelegramIdentity({ ...BASE, fetchImpl });
    expect(captures.length).toBe(3);
    expect(captures[0].url).toContain("/getMe");
    expect(captures[1].url).toContain("/getChat");
    expect(captures[2].url).toContain("/getChatMember");
  });

  it("getChat call carries chat_id=@<handle>; getChatMember carries chat_id + bot user_id", async () => {
    const captures: CapturedCall[] = [];
    const fetchImpl = makeFetch(defaultResponder, captures);
    await verifyTelegramIdentity({ ...BASE, fetchImpl });
    expect(captures[1].url).toContain("chat_id=%40webmasterid");
    expect(captures[2].url).toContain("chat_id=-1001234567890");
    expect(captures[2].url).toContain(`user_id=${BOT_USER_ID}`);
  });
});

// =====================================================================
// mismatch
// =====================================================================

describe("verifyTelegramIdentity — mismatch", () => {
  it("returns 'mismatched' when the channel resolves but its username is different", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/getChat")) {
        return {
          status: 200,
          body: {
            ok: true,
            result: {
              id: -100999,
              username: "OtherChannel",
              type: "channel",
            },
          },
        };
      }
      return defaultResponder(url);
    });
    const result = await verifyTelegramIdentity({
      ...BASE,
      declaredHandle: "webmasterid",
      fetchImpl,
    });
    expect(result.outcome).toBe("mismatched");
    if (result.outcome !== "mismatched") return;
    expect(result.declaredHandle).toBe("webmasterid");
    expect(result.authenticatedHandle).toBe("OtherChannel");
    expect(result.providerAccountId).toBe("-100999");
  });

  it("never calls getChatMember on mismatch (no point checking admin status)", async () => {
    const captures: CapturedCall[] = [];
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/getChat")) {
        return {
          status: 200,
          body: {
            ok: true,
            result: {
              id: -100999,
              username: "OtherChannel",
              type: "channel",
            },
          },
        };
      }
      return defaultResponder(url);
    }, captures);
    await verifyTelegramIdentity({ ...BASE, fetchImpl });
    const memberCalls = captures.filter((c) =>
      c.url.includes("/getChatMember"),
    );
    expect(memberCalls.length).toBe(0);
  });
});

// =====================================================================
// input validation
// =====================================================================

describe("verifyTelegramIdentity — input validation", () => {
  it("rejects empty declared handle without making a network call", async () => {
    const result = await verifyTelegramIdentity({
      ...BASE,
      declaredHandle: "",
      fetchImpl: (async () => {
        throw new Error("should not be called");
      }) as typeof fetch,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("handle_invalid");
  });

  it("rejects malformed declared handle (uppercase only is fine via normalize; bad shape rejected)", async () => {
    // After normalize: lowercased + @-stripped. The malformed cases
    // here all survive normalize as invalid (length, leading digit,
    // disallowed chars).
    for (const bad of [
      "abc", // too short
      "a".repeat(33), // too long
      "1starts_with_digit",
      "has space",
      "has.dot",
      "has-hyphen",
      "ends_underscore_", // ends with underscore
    ]) {
      const result = await verifyTelegramIdentity({
        ...BASE,
        declaredHandle: bad,
        fetchImpl: (async () => {
          throw new Error("should not be called");
        }) as typeof fetch,
      });
      expect(result.outcome).toBe("error");
      if (result.outcome !== "error") continue;
      expect(result.code).toBe("handle_invalid");
    }
  });

  it("accepts a handle with a leading @ (normalizer strips it)", async () => {
    const fetchImpl = makeFetch(defaultResponder);
    const result = await verifyTelegramIdentity({
      ...BASE,
      declaredHandle: "@webmasterid",
      fetchImpl,
    });
    expect(result.outcome).toBe("connected");
  });

  it("returns 'credentials_missing' (with safe operator message) when botToken is empty", async () => {
    const result = await verifyTelegramIdentity({
      ...BASE,
      botToken: "",
      fetchImpl: (async () => {
        throw new Error("should not be called");
      }) as typeof fetch,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("credentials_missing");
    expect(result.message.toLowerCase()).toContain("administrator");
  });

  it("returns 'credentials_missing' when botToken is whitespace-only", async () => {
    const result = await verifyTelegramIdentity({
      ...BASE,
      botToken: "   ",
      fetchImpl: (async () => {
        throw new Error("should not be called");
      }) as typeof fetch,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("credentials_missing");
  });
});

// =====================================================================
// provider failures
// =====================================================================

describe("verifyTelegramIdentity — getMe failures", () => {
  it("returns 'credentials_missing' on getMe 401 (bot token rejected)", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/getMe")) return { status: 401, body: {} };
      return defaultResponder(url);
    });
    const result = await verifyTelegramIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("credentials_missing");
  });

  it("returns 'provider_error' on getMe 500", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/getMe")) return { status: 500, body: {} };
      return defaultResponder(url);
    });
    const result = await verifyTelegramIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });

  it("returns 'provider_error' on getMe ok:false body", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/getMe")) {
        return {
          status: 200,
          body: { ok: false, description: "bad token" },
        };
      }
      return defaultResponder(url);
    });
    const result = await verifyTelegramIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });

  it("returns 'network_error' when getMe fetch throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    const result = await verifyTelegramIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("network_error");
  });
});

describe("verifyTelegramIdentity — getChat failures", () => {
  it("returns 'chat_not_found' when Telegram description says 'chat not found'", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/getChat")) {
        return {
          status: 400,
          body: {
            ok: false,
            error_code: 400,
            description: "Bad Request: chat not found",
          },
        };
      }
      return defaultResponder(url);
    });
    const result = await verifyTelegramIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("chat_not_found");
  });

  it("returns 'provider_error' on getChat malformed response (no result.username)", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/getChat")) {
        return {
          status: 200,
          body: { ok: true, result: { id: -100123 } }, // missing username
        };
      }
      return defaultResponder(url);
    });
    const result = await verifyTelegramIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });

  it("returns 'provider_error' on generic getChat error description", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/getChat")) {
        return {
          status: 200,
          body: {
            ok: false,
            error_code: 400,
            description: "internal Telegram-side hiccup",
          },
        };
      }
      return defaultResponder(url);
    });
    const result = await verifyTelegramIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });
});

describe("verifyTelegramIdentity — getChatMember failures (bot not admin)", () => {
  it("returns 'bot_not_admin' when getChatMember body is ok:false", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/getChatMember")) {
        return {
          status: 200,
          body: {
            ok: false,
            description: "user not found",
          },
        };
      }
      return defaultResponder(url);
    });
    const result = await verifyTelegramIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("bot_not_admin");
    expect(result.message.toLowerCase()).toContain("admin");
  });

  it("returns 'bot_not_admin' when the bot is a regular member (status='member')", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/getChatMember")) {
        return {
          status: 200,
          body: {
            ok: true,
            result: {
              user: { id: BOT_USER_ID, is_bot: true },
              status: "member",
            },
          },
        };
      }
      return defaultResponder(url);
    });
    const result = await verifyTelegramIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("bot_not_admin");
  });

  it("returns 'bot_not_admin' when admin but can_post_messages is explicitly false", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/getChatMember")) {
        return {
          status: 200,
          body: {
            ok: true,
            result: {
              user: { id: BOT_USER_ID, is_bot: true },
              status: "administrator",
              can_post_messages: false,
            },
          },
        };
      }
      return defaultResponder(url);
    });
    const result = await verifyTelegramIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("bot_not_admin");
  });
});

// =====================================================================
// leak guards — bot token must never appear in error/response surface
// =====================================================================

describe("verifyTelegramIdentity — leak guards", () => {
  const LEAK_PROBE = "999:LEAK-PROBE-TELEGRAM-BOT-TOKEN-xxxxxxxxxx";

  it("getMe failure: error message never contains the bot token", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/getMe")) return { status: 500, body: {} };
      return defaultResponder(url);
    });
    const result = await verifyTelegramIdentity({
      ...BASE,
      botToken: LEAK_PROBE,
      fetchImpl,
    });
    if (result.outcome === "error") {
      expect(result.message).not.toContain(LEAK_PROBE);
    }
  });

  it("network error message redacts the bot token even if the error message echoes the URL", async () => {
    const fetchImpl = (async () => {
      // Some fetch implementations echo the request URL in the error
      // — the verifier must redact the token before bubbling it up.
      throw new Error(
        `request to https://api.telegram.org/bot${LEAK_PROBE}/getMe failed`,
      );
    }) as typeof fetch;
    const result = await verifyTelegramIdentity({
      ...BASE,
      botToken: LEAK_PROBE,
      fetchImpl,
    });
    if (result.outcome === "error") {
      expect(result.message).not.toContain(LEAK_PROBE);
      expect(result.message).toContain("<redacted>");
    }
  });

  it("provider description containing the token (defensive) is redacted", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/getChat")) {
        return {
          status: 200,
          body: {
            ok: false,
            description: `internal: token=${LEAK_PROBE} failed lookup`,
          },
        };
      }
      return defaultResponder(url);
    });
    const result = await verifyTelegramIdentity({
      ...BASE,
      botToken: LEAK_PROBE,
      fetchImpl,
    });
    if (result.outcome === "error") {
      expect(result.message).not.toContain(LEAK_PROBE);
    }
  });

  it("connected result body never carries the bot token", async () => {
    const fetchImpl = makeFetch(defaultResponder);
    const result = await verifyTelegramIdentity({
      ...BASE,
      botToken: LEAK_PROBE,
      fetchImpl,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(LEAK_PROBE);
  });

  it("mismatched result body never carries the bot token", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/getChat")) {
        return {
          status: 200,
          body: {
            ok: true,
            result: { id: -100999, username: "DifferentName", type: "channel" },
          },
        };
      }
      return defaultResponder(url);
    });
    const result = await verifyTelegramIdentity({
      ...BASE,
      botToken: LEAK_PROBE,
      fetchImpl,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(LEAK_PROBE);
  });
});

// =====================================================================
// idempotency
// =====================================================================

describe("verifyTelegramIdentity — idempotency", () => {
  it("two calls with the same input produce structurally identical results", async () => {
    const fetchImpl = makeFetch(defaultResponder);
    const a = await verifyTelegramIdentity({ ...BASE, fetchImpl });
    const b = await verifyTelegramIdentity({ ...BASE, fetchImpl });
    expect(a).toEqual(b);
  });
});
