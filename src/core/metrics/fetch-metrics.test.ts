import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/core/publishing/fetch-with-timeout", () => ({
  fetchWithTimeout: vi.fn(),
  isTimeoutError: () => false,
}));

import { fetchVerifiedMetrics } from "./fetch-metrics";
import { fetchWithTimeout } from "@/core/publishing/fetch-with-timeout";

const mockFetch = vi.mocked(fetchWithTimeout);

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function notOk(status: number) {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("fetchVerifiedMetrics — verified platforms (real counts only)", () => {
  it("bluesky → likes/reposts/replies/quotes from public getPosts", async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({ posts: [{ likeCount: 5, repostCount: 2, replyCount: 1, quoteCount: 0 }] }),
    );
    const r = await fetchVerifiedMetrics({
      platform: "bluesky",
      externalPostId: "at://did:plc:abc/app.bsky.feed.post/1",
      permalink: null,
    });
    expect(r.status).toBe("connected");
    expect(r.metrics).toEqual({ likes: 5, reposts: 2, replies: 1, quotes: 0 });
  });

  it("reddit → score + comments from the official .json", async () => {
    mockFetch.mockResolvedValueOnce(
      okJson([{ data: { children: [{ data: { score: 10, num_comments: 3, name: "t3_x" } }] } }]),
    );
    const r = await fetchVerifiedMetrics({
      platform: "reddit",
      externalPostId: null,
      permalink: "https://www.reddit.com/r/test/comments/x/title/",
    });
    expect(r.status).toBe("connected");
    expect(r.metrics).toEqual({ score: 10, comments: 3 });
  });

  it("dev.to → public reactions + comments from articles/{id}", async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({ public_reactions_count: 7, comments_count: 2 }),
    );
    const r = await fetchVerifiedMetrics({ platform: "devto", externalPostId: "12345", permalink: null });
    expect(r.status).toBe("connected");
    expect(r.metrics).toEqual({ reactions: 7, comments: 2 });
  });

  it("bluesky with a missing at-uri → unavailable, no fetch, no fake metrics", async () => {
    const r = await fetchVerifiedMetrics({ platform: "bluesky", externalPostId: null, permalink: null });
    expect(r.status).toBe("unavailable");
    expect(r.metrics).toEqual({});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("bluesky non-OK response → unavailable, never fabricated", async () => {
    mockFetch.mockResolvedValueOnce(notOk(404));
    const r = await fetchVerifiedMetrics({
      platform: "bluesky",
      externalPostId: "at://did:plc:abc/app.bsky.feed.post/1",
      permalink: null,
    });
    expect(r.status).toBe("unavailable");
    expect(r.metrics).toEqual({});
    expect(r.error).toMatch(/404/);
  });

  it("dev.to with a non-numeric id → unavailable, no fetch", async () => {
    const r = await fetchVerifiedMetrics({ platform: "devto", externalPostId: "not-an-id", permalink: null });
    expect(r.status).toBe("unavailable");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("fetchVerifiedMetrics — unavailable platforms (real API, not reachable here)", () => {
  it.each(["x", "hashnode", "linkedin"])(
    "%s → unavailable with an explanation, never a fetch or estimate",
    async (platform) => {
      const r = await fetchVerifiedMetrics({ platform, externalPostId: "id", permalink: "p" });
      expect(r.status).toBe("unavailable");
      expect(r.metrics).toEqual({});
      expect(r.error).toBeTruthy();
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );
});

describe("fetchVerifiedMetrics — unsupported platforms never leak a fetch", () => {
  it.each(["telegram", "threads", "instagram", "youtube"])(
    "%s → unsupported, empty metrics, no fetch",
    async (platform) => {
      const r = await fetchVerifiedMetrics({ platform, externalPostId: "id", permalink: "p" });
      expect(r.status).toBe("unsupported");
      expect(r.metrics).toEqual({});
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );
});
