// Verifies the /metrics endpoint and the four KV-backed counters
// (get_hit, get_miss, put_ok, auth_fail). The worker treats the KV binding as
// optional — these tests wire a tiny in-memory stub and assert the worker
// reads/writes the expected keys through the auth-gated /metrics route.

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

beforeAll(() => {
  if (typeof (globalThis as any).caches === "undefined") {
    const store = new Map<string, Response>();
    const keyOf = (req: Request | string) =>
      typeof req === "string" ? req : req.url;
    (globalThis as any).caches = {
      default: {
        async match(req: Request | string): Promise<Response | undefined> {
          const r = store.get(keyOf(req));
          return r ? r.clone() : undefined;
        },
        async put(req: Request | string, res: Response): Promise<void> {
          store.set(keyOf(req), res.clone());
        },
        async delete(req: Request | string): Promise<boolean> {
          return store.delete(keyOf(req));
        },
      },
    };
  }
});

import worker, { type Env } from "../src/index";

class StubKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

class EmptyR2 {
  async head(): Promise<null> {
    return null;
  }
  async get(): Promise<null> {
    return null;
  }
  async put(): Promise<unknown> {
    throw new Error("not used");
  }
}

const UPLOAD_TOKEN = "s3cret-test-token";

function makeEnv(opts: { metrics?: boolean; token?: boolean } = {}): {
  env: Env;
  kv?: StubKV;
} {
  const kv = opts.metrics === false ? undefined : new StubKV();
  const env: Env = {
    BUCKET: new EmptyR2() as unknown as R2Bucket,
    METRICS: kv as unknown as KVNamespace | undefined,
    UPLOAD_TOKEN: opts.token === false ? undefined : UPLOAD_TOKEN,
  };
  return { env, kv };
}

// The worker schedules counter increments via ctx.waitUntil. The test ctx
// collects those promises and exposes a `flush()` so assertions can wait for
// the KV writes to settle before reading them back.
function makeCtx(): { ctx: ExecutionContext; flush: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    flush: async () => {
      while (pending.length) {
        await Promise.allSettled(pending.splice(0, pending.length));
      }
    },
  };
}

function metricsReq(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return new Request("https://nix-cache.stevedores.org/metrics", {
    method: "GET",
    headers,
  });
}

describe("/metrics endpoint", () => {
  test("503 when UPLOAD_TOKEN is unset (metrics gated by the same secret)", async () => {
    const { env } = makeEnv({ token: false });
    const { ctx } = makeCtx();
    const res = await worker.fetch(metricsReq(UPLOAD_TOKEN), env, ctx);
    expect(res.status).toBe(503);
  });

  test("401 with no bearer; increments auth_fail", async () => {
    const { env, kv } = makeEnv();
    const { ctx, flush } = makeCtx();
    const res = await worker.fetch(metricsReq(), env, ctx);
    expect(res.status).toBe(401);
    await flush();
    expect(kv?.store.get("auth_fail")).toBe("1");
  });

  test("401 with wrong bearer; increments auth_fail", async () => {
    const { env, kv } = makeEnv();
    const { ctx, flush } = makeCtx();
    const res = await worker.fetch(metricsReq("not-the-token"), env, ctx);
    expect(res.status).toBe(401);
    await flush();
    expect(kv?.store.get("auth_fail")).toBe("1");
  });

  test("200 with valid bearer returns counters JSON (zeros when KV is empty)", async () => {
    const { env } = makeEnv();
    const { ctx } = makeCtx();
    const res = await worker.fetch(metricsReq(UPLOAD_TOKEN), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      get_hit: 0,
      get_miss: 0,
      put_ok: 0,
      auth_fail: 0,
      get_total: 0,
    });
  });

  test("GET on a missing object increments get_miss and surfaces in /metrics", async () => {
    const { env, kv } = makeEnv();
    const { ctx, flush } = makeCtx();
    const missing = new Request(
      "https://nix-cache.stevedores.org/00000000000000000000000000000099.narinfo",
      { method: "GET" },
    );
    const res = await worker.fetch(missing, env, ctx);
    expect(res.status).toBe(404);
    await flush();
    expect(kv?.store.get("get_miss")).toBe("1");

    const m = await worker.fetch(metricsReq(UPLOAD_TOKEN), env, ctx);
    const body = (await m.json()) as Record<string, number>;
    expect(body.get_miss).toBe(1);
    expect(body.get_total).toBe(1);
  });

  test("KV binding absent → /metrics still gated by token, counters all zero", async () => {
    const { env } = makeEnv({ metrics: false });
    const { ctx } = makeCtx();
    const res = await worker.fetch(metricsReq(UPLOAD_TOKEN), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body.get_hit).toBe(0);
    expect(body.get_miss).toBe(0);
    expect(body.put_ok).toBe(0);
    expect(body.auth_fail).toBe(0);
    expect(body.get_total).toBe(0);
  });
});
