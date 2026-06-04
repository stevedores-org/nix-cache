import { describe, expect, test } from "bun:test";
import { normalizeEtag, respondFromCache } from "./index";

describe("normalizeEtag", () => {
  test("strips weak validators and quotes", () => {
    expect(normalizeEtag('W/"abc123"')).toBe("abc123");
    expect(normalizeEtag('"abc123"')).toBe("abc123");
    expect(normalizeEtag("abc123")).toBe("abc123");
  });
});

describe("respondFromCache", () => {
  test("returns 304 when the cached etag matches the conditional", () => {
    const cached = new Response("body", {
      status: 200,
      headers: {
        etag: "abc123",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });

    const response = respondFromCache(cached, "abc123");

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe("abc123");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  test("returns the cached response unchanged when the etag does not match", () => {
    const cached = new Response("body", {
      status: 200,
      headers: { etag: "abc123" },
    });

    const response = respondFromCache(cached, "def456");

    expect(response).toBe(cached);
    expect(response.status).toBe(200);
  });
});
