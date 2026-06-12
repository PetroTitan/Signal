import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadXMedia } from "./publish-x";

/**
 * Provider-media-prep regression guards for the X media path.
 *
 * `uploadXMedia` must consult the X per-image limit in-flight and
 * refuse an oversized image BEFORE POSTing to /2/media/upload (and
 * therefore before the tweet). This is the X analogue of the Bluesky
 * "blob too big" fix.
 */

const originalFetch = globalThis.fetch;

function imageResp(byteLength: number): Response {
  const bytes = new Uint8Array(byteLength);
  bytes[0] = 0x89;
  bytes[1] = 0x50; // PNG-ish magic
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Type": "image/png" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("uploadXMedia — in-flight provider-media guard", () => {
  it("blocks a 6MB image before the /2/media/upload POST", async () => {
    // 6 MB > X's ~5 MB ceiling. Only the image GET should happen; the
    // upload POST must NOT be reached.
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.includes("/2/media/upload")) {
        throw new Error("upload POST must not be reached for an oversized image");
      }
      return imageResp(6 * 1024 * 1024);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const r = await uploadXMedia({
      accessToken: "atk",
      photoUrl: "https://cdn.example.com/big.png",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.tooLarge).toBe(true);
      expect(r.reasonDetail).toMatch(/limit/i);
    }
    // Exactly one fetch — the image GET. No media upload POST.
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("/2/media/upload");
  });

  it("allows a within-limit image through to the upload POST", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.includes("/2/media/upload")) {
        return new Response(JSON.stringify({ data: { id: "media-123" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return imageResp(1_000_000); // 1 MB — well under the limit
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const r = await uploadXMedia({
      accessToken: "atk",
      photoUrl: "https://cdn.example.com/ok.png",
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mediaId).toBe("media-123");
    // Both the image GET and the upload POST happened.
    expect(calls.some((u) => u.includes("/2/media/upload"))).toBe(true);
  });
});
