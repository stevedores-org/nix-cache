import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";

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

// In-memory KV stub
function makeKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key) || null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

function makeEnv(token = "test-secret-token") {
  return {
    BUCKET: makeBucket() as unknown as R2Bucket,
    METRICS: makeKV() as unknown as KVNamespace,
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
      const json = (await res.json()) as { status: string; cache: string };
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
      const json = (await res.json()) as { error: string };
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
      const getRes = await worker.fetch(new Request("https://nix-cache.stevedores.org/abc123.narinfo"), env);
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

      const getRes = await worker.fetch(new Request("https://nix-cache.stevedores.org/nar/abc123.nar"), env);
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("Content-Type")).toBe("application/x-nix-archive");
      expect(await getRes.text()).toBe(narData);
    });
  });

  describe("GET 404", () => {
    it("returns 404 for missing objects", async () => {
      const res = await worker.fetch(new Request("https://nix-cache.stevedores.org/nonexistent.narinfo"), env);
      expect(res.status).toBe(404);
    });
  });

  describe("method not allowed", () => {
    it("rejects DELETE", async () => {
      const res = await worker.fetch(new Request("https://nix-cache.stevedores.org/test", { method: "DELETE" }), env);
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

  // ── Issue #5: Namespace / protocol mismatch characterization ──
  // The worker does flat R2 lookup. Attic-style namespaced paths like
  // /stevedores/hash.narinfo are stored as "stevedores/hash.narinfo" in R2.
  // These tests document the current behavior so regressions are caught
  // if/when namespace routing is added.

  describe("namespaced paths (issue #5)", () => {
    it("stores and retrieves objects with namespace prefix", async () => {
      const putRes = await worker.fetch(
        new Request("https://nix-cache.stevedores.org/stevedores/abc123.narinfo", {
          method: "PUT",
          body: "StorePath: /nix/store/abc123-namespaced",
          headers: { Authorization: "Bearer test-secret-token" },
        }),
        env,
      );
      expect(putRes.status).toBe(201);

      // R2 key is "stevedores/abc123.narinfo" (flat, with prefix)
      const bucket = env.BUCKET as unknown as ReturnType<typeof makeBucket>;
      expect(bucket.store.has("stevedores/abc123.narinfo")).toBe(true);

      const getRes = await worker.fetch(new Request("https://nix-cache.stevedores.org/stevedores/abc123.narinfo"), env);
      expect(getRes.status).toBe(200);
      expect(await getRes.text()).toBe("StorePath: /nix/store/abc123-namespaced");
    });

    it("namespaced and root paths are isolated", async () => {
      await worker.fetch(
        new Request("https://nix-cache.stevedores.org/abc123.narinfo", {
          method: "PUT",
          body: "root-version",
          headers: { Authorization: "Bearer test-secret-token" },
        }),
        env,
      );
      await worker.fetch(
        new Request("https://nix-cache.stevedores.org/lornu/abc123.narinfo", {
          method: "PUT",
          body: "lornu-version",
          headers: { Authorization: "Bearer test-secret-token" },
        }),
        env,
      );

      const rootRes = await worker.fetch(new Request("https://nix-cache.stevedores.org/abc123.narinfo"), env);
      expect(rootRes.status).toBe(200);
      expect(await rootRes.text()).toBe("root-version");

      const nsRes = await worker.fetch(new Request("https://nix-cache.stevedores.org/lornu/abc123.narinfo"), env);
      expect(nsRes.status).toBe(200);
      expect(await nsRes.text()).toBe("lornu-version");
    });

    it("sets correct content-type for namespaced .narinfo", async () => {
      await worker.fetch(
        new Request("https://nix-cache.stevedores.org/stevedores/xyz.narinfo", {
          method: "PUT",
          body: "StorePath: /nix/store/xyz-test",
          headers: { Authorization: "Bearer test-secret-token" },
        }),
        env,
      );
      const res = await worker.fetch(new Request("https://nix-cache.stevedores.org/stevedores/xyz.narinfo"), env);
      expect(res.headers.get("Content-Type")).toBe("text/x-nix-narinfo");
    });

    it("sets correct content-type for namespaced .nar", async () => {
      await worker.fetch(
        new Request("https://nix-cache.stevedores.org/stevedores/nar/xyz.nar", {
          method: "PUT",
          body: "nar-data",
          headers: { Authorization: "Bearer test-secret-token" },
        }),
        env,
      );
      const res = await worker.fetch(new Request("https://nix-cache.stevedores.org/stevedores/nar/xyz.nar"), env);
      expect(res.headers.get("Content-Type")).toBe("application/x-nix-archive");
    });

    it("returns 404 for missing namespaced object", async () => {
      const res = await worker.fetch(new Request("https://nix-cache.stevedores.org/oxidizedmlx/missing.narinfo"), env);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT overwrite", () => {
    it("overwrites existing object with new content", async () => {
      const auth = { Authorization: "Bearer test-secret-token" };

      await worker.fetch(
        new Request("https://nix-cache.stevedores.org/overwrite.narinfo", {
          method: "PUT",
          body: "version-1",
          headers: auth,
        }),
        env,
      );

      await worker.fetch(
        new Request("https://nix-cache.stevedores.org/overwrite.narinfo", {
          method: "PUT",
          body: "version-2",
          headers: auth,
        }),
        env,
      );

      const res = await worker.fetch(new Request("https://nix-cache.stevedores.org/overwrite.narinfo"), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("version-2");
    });
  });

  describe("response headers", () => {
    it("includes etag on GET", async () => {
      await worker.fetch(
        new Request("https://nix-cache.stevedores.org/etag-test.narinfo", {
          method: "PUT",
          body: "etag-content",
          headers: { Authorization: "Bearer test-secret-token" },
        }),
        env,
      );

      const res = await worker.fetch(new Request("https://nix-cache.stevedores.org/etag-test.narinfo"), env);
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBeTruthy();
    });
  });

  describe("edge cases", () => {
    it("rejects PATCH method", async () => {
      const res = await worker.fetch(new Request("https://nix-cache.stevedores.org/test", { method: "PATCH" }), env);
      expect(res.status).toBe(405);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Method not allowed");
    });

    it("rejects Bearer scheme with no token value", async () => {
      const res = await worker.fetch(
        new Request("https://nix-cache.stevedores.org/test", {
          method: "PUT",
          body: "data",
          headers: { Authorization: "Bearer " },
        }),
        env,
      );
      // "Bearer " splits to ["Bearer", ""] — empty token should be rejected
      expect(res.status).toBe(401);
    });

    it("metrics auth failure increments counter", async () => {
      await worker.fetch(
        new Request("https://nix-cache.stevedores.org/metrics", {
          headers: { Authorization: "Bearer wrong" },
        }),
        env,
      );

      // Check counter via authenticated metrics endpoint
      const res = await worker.fetch(
        new Request("https://nix-cache.stevedores.org/metrics", {
          headers: { Authorization: "Bearer test-secret-token" },
        }),
        env,
      );
      const json = (await res.json()) as Record<string, number>;
      expect(json.auth_fail).toBe(1);
    });
  });

  describe("GET /metrics", () => {
    it("rejects unauthenticated requests", async () => {
      const res = await worker.fetch(new Request("https://nix-cache.stevedores.org/metrics"), env);
      expect(res.status).toBe(401);
    });

    it("returns counters after activity", async () => {
      // Generate some activity: 1 hit, 1 miss, 1 put, 1 auth fail
      await worker.fetch(new Request("https://nix-cache.stevedores.org/miss.narinfo"), env);
      await worker.fetch(
        new Request("https://nix-cache.stevedores.org/obj", {
          method: "PUT",
          body: "data",
          headers: { Authorization: "Bearer test-secret-token" },
        }),
        env,
      );
      await worker.fetch(new Request("https://nix-cache.stevedores.org/obj"), env);
      await worker.fetch(
        new Request("https://nix-cache.stevedores.org/obj", {
          method: "PUT",
          body: "x",
          headers: { Authorization: "Bearer bad" },
        }),
        env,
      );

      const res = await worker.fetch(
        new Request("https://nix-cache.stevedores.org/metrics", {
          headers: { Authorization: "Bearer test-secret-token" },
        }),
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, number>;
      expect(json.get_hit).toBe(1);
      expect(json.get_miss).toBe(1);
      expect(json.put_ok).toBe(1);
      expect(json.auth_fail).toBe(1);
      expect(json.get_total).toBe(2);
    });
  });
});

// ── GitHub Actions composite action validation ──────────────────────

const ROOT = join(import.meta.dir, "..");

describe("GitHub Actions: setup action", () => {
  const actionPath = join(ROOT, ".github/actions/setup/action.yml");

  it("action.yml exists", () => {
    expect(existsSync(actionPath)).toBe(true);
  });

  it("uses composite runner", () => {
    const content = readFileSync(actionPath, "utf-8");
    expect(content).toContain('using: "composite"');
  });

  it("installs Nix via DeterminateSystems installer", () => {
    const content = readFileSync(actionPath, "utf-8");
    expect(content).toContain("DeterminateSystems/nix-installer-action");
  });

  it("configures stevedores substituter and public key", () => {
    const content = readFileSync(actionPath, "utf-8");
    expect(content).toContain("nix-cache.stevedores.org");
    expect(content).toContain("stevedores-cache-1:");
  });

  it("declares push input with default false", () => {
    const content = readFileSync(actionPath, "utf-8");
    expect(content).toContain("push:");
    expect(content).toContain('default: "false"');
  });

  it("declares cache-auth-token and signing-secret-key inputs", () => {
    const content = readFileSync(actionPath, "utf-8");
    expect(content).toContain("cache-auth-token:");
    expect(content).toContain("signing-secret-key:");
  });

  it("sets up signing key only when push is true", () => {
    const content = readFileSync(actionPath, "utf-8");
    expect(content).toContain("inputs.push == 'true'");
    expect(content).toContain("nix-sign-key");
  });
});

describe("GitHub Actions: push action", () => {
  const actionPath = join(ROOT, ".github/actions/push/action.yml");

  it("action.yml exists", () => {
    expect(existsSync(actionPath)).toBe(true);
  });

  it("uses composite runner", () => {
    const content = readFileSync(actionPath, "utf-8");
    expect(content).toContain('using: "composite"');
  });

  it("declares paths input as required", () => {
    const content = readFileSync(actionPath, "utf-8");
    expect(content).toContain("paths:");
    expect(content).toContain("required: true");
  });

  it("signs store paths with nix store sign", () => {
    const content = readFileSync(actionPath, "utf-8");
    expect(content).toContain("nix store sign");
  });

  it("copies to nix-cache.stevedores.org", () => {
    const content = readFileSync(actionPath, "utf-8");
    expect(content).toContain("nix copy --to");
    expect(content).toContain("nix-cache.stevedores.org");
  });
});

describe("GitHub Actions: CI workflow", () => {
  const ciPath = join(ROOT, ".github/workflows/ci.yml");

  it("ci.yml exists", () => {
    expect(existsSync(ciPath)).toBe(true);
  });

  it("runs typecheck and test jobs", () => {
    const content = readFileSync(ciPath, "utf-8");
    expect(content).toContain("bun run typecheck");
    expect(content).toContain("bun run test");
  });

  it("triggers on pull_request and push to develop/main", () => {
    const content = readFileSync(ciPath, "utf-8");
    expect(content).toContain("pull_request");
    expect(content).toContain("develop");
    expect(content).toContain("main");
  });
});

describe("local-ci configuration", () => {
  const lciPath = join(ROOT, ".lci.toml");

  it(".lci.toml exists", () => {
    expect(existsSync(lciPath)).toBe(true);
  });

  it("configures typecheck and test as default stages", () => {
    const content = readFileSync(lciPath, "utf-8");
    expect(content).toContain("typecheck");
    expect(content).toContain("test");
  });
});
