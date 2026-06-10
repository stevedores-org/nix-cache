// Regression test for: HEAD with `If-None-Match` was returning 200 instead of
// 304 when the etag matched (RFC 9110 §13.1.2 violation). The test wires a
// minimal R2 stub against the worker's fetch handler so the conditional path
// is exercised without spinning up wrangler.

import { beforeAll, describe, expect, test } from "bun:test";

// Cloudflare Workers expose `caches.default`; bun's test runtime doesn't.
// Stub it with an in-memory Map so the worker's `caches.default.match` /
// `caches.default.put` calls work in this test file. Mock supports the
// `Request|string` keying that the worker uses (it constructs a Request key).
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

class StubR2Object {
  constructor(
    private bodyBytes: Uint8Array,
    public httpEtag: string,
  ) {}
  get size() {
    return this.bodyBytes.length;
  }
  get body(): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start: (controller) => {
        controller.enqueue(this.bodyBytes);
        controller.close();
      },
    });
  }
  writeHttpMetadata(_h: Headers): void {
    // narinfo metadata is set explicitly by the worker via setContentType
  }
}

class StubR2Bucket {
  // narinfo hash chosen to satisfy `^[0-9a-z]{32}\.narinfo$`
  static readonly KEY = "00000000000000000000000000000001.narinfo";
  static readonly ETAG = '"deadbeefdeadbeefdeadbeefdeadbeef"';
  static readonly BODY = "StorePath: /nix/store/abc\n";

  async head(name: string): Promise<StubR2Object | null> {
    if (name !== StubR2Bucket.KEY) return null;
    return new StubR2Object(new TextEncoder().encode(StubR2Bucket.BODY), StubR2Bucket.ETAG);
  }
  async get(name: string, opts?: any): Promise<StubR2Object | null> {
    if (name !== StubR2Bucket.KEY) return null;
    if (opts?.onlyIf?.etagDoesNotMatch) {
      const want = opts.onlyIf.etagDoesNotMatch;
      // The worker calls normalizeEtag before passing, so `want` is unquoted.
      const haveUnquoted = StubR2Bucket.ETAG.replace(/^"|"$/g, "");
      if (haveUnquoted === want) return null;
    }
    return new StubR2Object(new TextEncoder().encode(StubR2Bucket.BODY), StubR2Bucket.ETAG);
  }
  async put(): Promise<unknown> {
    throw new Error("PUT not used in this test");
  }
}

const env: Env = { BUCKET: new StubR2Bucket() as unknown as R2Bucket };
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

function headReq(ifNoneMatch?: string): Request {
  const headers: Record<string, string> = {};
  if (ifNoneMatch !== undefined) headers["if-none-match"] = ifNoneMatch;
  return new Request(`https://nix-cache.stevedores.org/${StubR2Bucket.KEY}`, {
    method: "HEAD",
    headers,
  });
}

describe("HEAD conditional", () => {

  test("HEAD with matching If-None-Match returns 304 (was 200 — RFC 9110 §13.1.2)", async () => {
    const res = await worker.fetch(
      headReq(StubR2Bucket.ETAG),
      env,
      ctx,
    );
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(StubR2Bucket.ETAG);
    expect(await res.text()).toBe("");
  });

  test("HEAD with weak validator W/ matching variant also returns 304", async () => {
    const res = await worker.fetch(
      headReq(`W/${StubR2Bucket.ETAG}`),
      env,
      ctx,
    );
    expect(res.status).toBe(304);
  });

  test("HEAD with non-matching If-None-Match returns 200 with headers", async () => {
    const res = await worker.fetch(
      headReq('"someothertag"'),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(StubR2Bucket.ETAG);
    expect(res.headers.get("Content-Length")).toBe(
      String(new TextEncoder().encode(StubR2Bucket.BODY).length),
    );
    expect(await res.text()).toBe("");
  });

  test("HEAD without If-None-Match preserves existing behaviour (200)", async () => {
    const res = await worker.fetch(headReq(), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(StubR2Bucket.ETAG);
  });

  test("HEAD for a missing object still returns 404 regardless of If-None-Match", async () => {
    const missingReq = new Request(
      `https://nix-cache.stevedores.org/00000000000000000000000000000002.narinfo`,
      { method: "HEAD", headers: { "if-none-match": StubR2Bucket.ETAG } },
    );
    const res = await worker.fetch(missingReq, env, ctx);
    expect(res.status).toBe(404);
  });
});
