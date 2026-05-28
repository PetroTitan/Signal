import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadXMedia } from "./publish-x";

/**
 * X media-upload unit tests (`uploadXMedia` HTTP layer).
 *
 * Pins:
 *   - happy path: fetches image bytes, POSTs to /2/media/upload as
 *     multipart, returns mediaId
 *   - 403 → x_media_upload_unavailable (tier-gated case)
 *   - 401 / 413 / 4xx / 5xx → x_media_upload_failed with the right
 *     reason detail and http_status
 *   - network / timeout / empty body / non-JSON → x_media_upload_failed
 *   - missing access token or photo URL → x_media_upload_failed
 *     without any fetch
 *   - access token never appears in returned result
 */

const originalFetch = globalThis.fetch;

function pngResp(): Response {
  // Small fake "image" — content-type is what we care about.
  return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    status: 200,
    headers: { "Content-Type": "image/png" },
  });
}

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResp(status: number, body: string): Response {
  return new Response(body, { status });
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// =====================================================================
// Pre-network refusals
// =====================================================================

describe("uploadXMedia — pre-network refusals", () => {
  it("missing access token → x_media_upload_failed (no fetch)", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const r = await uploadXMedia({
      accessToken: "",
      photoUrl: "https://cdn.example.com/a.png",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasonCode).toBe("x_media_upload_failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("missing photo URL → x_media_upload_failed (no fetch)", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const r = await uploadXMedia({ accessToken: "atk", photoUrl: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasonCode).toBe("x_media_upload_failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// =====================================================================
// happy path
// =====================================================================

describe("uploadXMedia — happy path", () => {
  it("fetches image bytes, POSTs to /2/media/upload as multipart, returns data.id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pngResp())
      .mockResolvedValueOnce(jsonResp(201, { data: { id: "media_99" } }));
    globalThis.fetch = fetchMock;

    const r = await uploadXMedia({
      accessToken: "atk_user_context",
      photoUrl: "https://cdn.example.com/a.png",
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mediaId).toBe("media_99");

    // Call 1: image fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [imgUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(imgUrl).toBe("https://cdn.example.com/a.png");

    // Call 2: X upload.
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(uploadUrl).toBe("https://api.twitter.com/2/media/upload");
    expect(uploadInit.method).toBe("POST");
    expect((uploadInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer atk_user_context",
    );
    expect(uploadInit.body).toBeInstanceOf(FormData);
    const form = uploadInit.body as FormData;
    expect(form.get("media_category")).toBe("tweet_image");
    expect(form.get("media")).not.toBeNull();
  });
});

// =====================================================================
// tier-gated 403
// =====================================================================

describe("uploadXMedia — tier-gated 403", () => {
  it("upload returns 403 → x_media_upload_unavailable with http_status=403", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(pngResp())
      .mockResolvedValueOnce(
        jsonResp(403, {
          title: "Forbidden",
          detail:
            "Your client app is not enabled for media upload on this tier.",
        }),
      );
    const r = await uploadXMedia({
      accessToken: "atk",
      photoUrl: "https://cdn.example.com/a.png",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasonCode).toBe("x_media_upload_unavailable");
      expect(r.httpStatus).toBe(403);
      expect(r.reasonDetail).toContain("403");
      expect(r.reasonDetail).toContain("tier");
    }
  });
});

// =====================================================================
// other failure modes — x_media_upload_failed
// =====================================================================

describe("uploadXMedia — other provider failures", () => {
  it("image fetch returns non-2xx → x_media_upload_failed", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(textResp(404, ""));
    const r = await uploadXMedia({
      accessToken: "atk",
      photoUrl: "https://cdn.example.com/missing.png",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasonCode).toBe("x_media_upload_failed");
      expect(r.httpStatus).toBe(404);
    }
  });

  it("upload returns 401 → x_media_upload_failed (not unavailable)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(pngResp())
      .mockResolvedValueOnce(textResp(401, "unauthorized"));
    const r = await uploadXMedia({
      accessToken: "atk",
      photoUrl: "https://cdn.example.com/a.png",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasonCode).toBe("x_media_upload_failed");
      expect(r.httpStatus).toBe(401);
    }
  });

  it("upload returns 413 → x_media_upload_failed with size-limit reason", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(pngResp())
      .mockResolvedValueOnce(textResp(413, "too big"));
    const r = await uploadXMedia({
      accessToken: "atk",
      photoUrl: "https://cdn.example.com/big.png",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasonCode).toBe("x_media_upload_failed");
      expect(r.httpStatus).toBe(413);
      expect(r.reasonDetail).toContain("too large");
    }
  });

  it("upload returns 5xx → x_media_upload_failed", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(pngResp())
      .mockResolvedValueOnce(textResp(503, "down"));
    const r = await uploadXMedia({
      accessToken: "atk",
      photoUrl: "https://cdn.example.com/a.png",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasonCode).toBe("x_media_upload_failed");
      expect(r.httpStatus).toBe(503);
    }
  });

  it("network error on image fetch → x_media_upload_failed", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    const r = await uploadXMedia({
      accessToken: "atk",
      photoUrl: "https://cdn.example.com/a.png",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasonCode).toBe("x_media_upload_failed");
  });

  it("upload response is non-JSON → x_media_upload_failed", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(pngResp())
      .mockResolvedValueOnce(new Response("not json", { status: 200 }));
    const r = await uploadXMedia({
      accessToken: "atk",
      photoUrl: "https://cdn.example.com/a.png",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasonCode).toBe("x_media_upload_failed");
  });

  it("upload response is missing data.id → x_media_upload_failed", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(pngResp())
      .mockResolvedValueOnce(jsonResp(200, { other: "shape" }));
    const r = await uploadXMedia({
      accessToken: "atk",
      photoUrl: "https://cdn.example.com/a.png",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasonCode).toBe("x_media_upload_failed");
  });
});

// =====================================================================
// secret hygiene
// =====================================================================

describe("uploadXMedia — secret hygiene", () => {
  it("access token does not appear in any returned field on success or failure", async () => {
    const TOKEN = "atk_user_context_TOP_SECRET_99";
    // failure
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("ECONN"));
    const failR = await uploadXMedia({
      accessToken: TOKEN,
      photoUrl: "https://cdn.example.com/a.png",
    });
    expect(JSON.stringify(failR)).not.toContain(TOKEN);
    // success
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(pngResp())
      .mockResolvedValueOnce(jsonResp(201, { data: { id: "m_1" } }));
    const okR = await uploadXMedia({
      accessToken: TOKEN,
      photoUrl: "https://cdn.example.com/a.png",
    });
    expect(JSON.stringify(okR)).not.toContain(TOKEN);
  });
});
