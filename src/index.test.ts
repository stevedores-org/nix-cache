import { describe, it, expect, beforeEach } from "bun:test";

// Minimal R2Object stub
function makeR2Object(body: string, key: string) {
  return {
    key,
    body: new Response(body).body,
    httpEtag: `"${key}-etag"`,
    writeHttpMetadata(headers: Headers) {
      headers.set("Content-Type", "application/octet-stream");
    },
  };
}

// In-memory R2 bucket stub
function makeBucket() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      const val = store.get(key);
      if (!val) return null;
      return makeR2Object(val, key);
    },
    async put(key: string, body: ReadableStream | string | null) {
      const text = typeof body === "string" ? body : body ? await new Response(body).text() : "";
      store.set(key, text);
    },
  };
}

function makeEnv(token = "test-secret-token") {
  return {
    BUCKET: makeBucket() as unknown as R2Bucket,
    CACHE_AUTH_TOKEN: token,
  };
}

// Import the worker
import worker from "./index";

describe("nix-cache worker", () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv();
  });

  describe("GET /nix-cache-info", () => {
    it("returns cache info", async () => {
      const res = await worker.fetch(new Request("https://nix-cache.stevedores.org/nix-cache-info"), env);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("StoreDir: /nix/store");
      expect(text).toContain("WantMassQuery: 1");
      expect(res.headers.get("Content-Type")).toBe("text/x-nix-cache-info");
    });

    it("returns cache info on /", async () => {
      const res = await worker.fetch(new Request("https://nix-cache.stevedores.org/"), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("StoreDir: /nix/store");
    });
  });

  describe("GET /health", () => {
    it("returns health JSON", async () => {
      const res = await worker.fetch(new Request("https://nix-cache.stevedores.org/health"), env);
      expect(res.status).toBe(200);
      const json = await res.json() as { status: string; cache: string };
      expect(json.status).toBe("ok");
      expect(json.cache).toBe("nix-cache");
    });
  });

  describe("PUT auth", () => {
    it("rejects missing Authorization", async () => {
      const res = await worker.fetch(
        new Request("https://nix-cache.stevedores.org/test.narinfo", { method: "PUT", body: "data" }),
        env,
      );
      expect(res.status).toBe(401);
      const json = await res.json() as { error: string };
      expect(json.error).toContain("Missing");
    });

    it("rejects non-Bearer scheme", async () => {
      const res = await worker.fetch(
        new Request("https://nix-cache.stevedores.org/test.narinfo", {
          method: "PUT",
          body: "data",
          headers: { Authorization: "Basic dXNlcjpwYXNz" },
        }),
        env,
      );
      expect(res.status).toBe(401);
    });

    it("rejects invalid token", async () => {
      const res = await worker.fetch(
        new Request("https://nix-cache.stevedores.org/test.narinfo", {
          method: "PUT",
          body: "data",
          headers: { Authorization: "Bearer wrong-token" },
        }),
        env,
      );
      expect(res.status).toBe(403);
    });

    it("accepts valid token and stores object", async () => {
      const res = await worker.fetch(
        new Request("https://nix-cache.stevedores.org/abc123.narinfo", {
          method: "PUT",
          body: "StorePath: /nix/store/abc123-hello",
          headers: { Authorization: "Bearer test-secret-token" },
        }),
        env,
      );
      expect(res.status).toBe(201);

      // Verify we can GET it back
      const getRes = await worker.fetch(
        new Request("https://nix-cache.stevedores.org/abc123.narinfo"),
        env,
      );
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("Content-Type")).toBe("text/x-nix-narinfo");
      expect(await getRes.text()).toBe("StorePath: /nix/store/abc123-hello");
    });
  });

  describe("PUT + GET roundtrip for .nar", () => {
    it("stores and retrieves a nar file", async () => {
      const narData = "fake-nar-archive-data";
      const putRes = await worker.fetch(
        new Request("https://nix-cache.stevedores.org/nar/abc123.nar", {
          method: "PUT",
          body: narData,
          headers: { Authorization: "Bearer test-secret-token" },
        }),
        env,
      );
      expect(putRes.status).toBe(201);

      const getRes = await worker.fetch(
        new Request("https://nix-cache.stevedores.org/nar/abc123.nar"),
        env,
      );
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("Content-Type")).toBe("application/x-nix-archive");
      expect(await getRes.text()).toBe(narData);
    });
  });

  describe("GET 404", () => {
    it("returns 404 for missing objects", async () => {
      const res = await worker.fetch(
        new Request("https://nix-cache.stevedores.org/nonexistent.narinfo"),
        env,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("method not allowed", () => {
    it("rejects DELETE", async () => {
      const res = await worker.fetch(
        new Request("https://nix-cache.stevedores.org/test", { method: "DELETE" }),
        env,
      );
      expect(res.status).toBe(405);
    });
  });

  describe("misconfigured server", () => {
    it("returns 500 when CACHE_AUTH_TOKEN is empty", async () => {
      const badEnv = makeEnv("");
      const res = await worker.fetch(
        new Request("https://nix-cache.stevedores.org/test", {
          method: "PUT",
          body: "data",
          headers: { Authorization: "Bearer something" },
        }),
        badEnv,
      );
      expect(res.status).toBe(500);
    });
  });
});
