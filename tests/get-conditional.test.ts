// Regression test for: GET with `If-None-Match` was returning 404 instead of
// 304 when the etag matched. The R2 `onlyIf: { etagDoesNotMatch }` makes
// `BUCKET.get` return null on a match; the worker then heads the object to
// disambiguate 304 vs 404/416. It compared the quoted `head.httpEtag` against
// the normalized (unquoted) `conditionalEtag`, so the 304 branch never fired
// and the request fell through to 404. Mirrors tests/head-conditional.test.ts.

import { beforeAll, describe, expect, test } from "bun:test";

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
  writeHttpMetadata(_h: Headers): void {}
}

class StubR2Bucket {
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
      const haveUnquoted = StubR2Bucket.ETAG.replace(/^"|"$/g, "");
      if (haveUnquoted === want) return null; // condition failed → R2 returns null
    }
    return new StubR2Object(new TextEncoder().encode(StubR2Bucket.BODY), StubR2Bucket.ETAG);
  }
  async put(): Promise<unknown> {
    throw new Error("PUT not used in this test");
  }
}

const env: Env = { BUCKET: new StubR2Bucket() as unknown as R2Bucket };
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

function getReq(ifNoneMatch?: string): Request {
  const headers: Record<string, string> = {};
  if (ifNoneMatch !== undefined) headers["if-none-match"] = ifNoneMatch;
  return new Request(`https://nix-cache.stevedores.org/${StubR2Bucket.KEY}`, {
    method: "GET",
    headers,
  });
}

describe("GET conditional", () => {
  test("GET with matching If-None-Match returns 304 (was 404)", async () => {
    const res = await worker.fetch(getReq(StubR2Bucket.ETAG), env, ctx);
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(StubR2Bucket.ETAG);
    expect(await res.text()).toBe("");
  });

  test("GET with weak validator W/ matching variant also returns 304", async () => {
    const res = await worker.fetch(getReq(`W/${StubR2Bucket.ETAG}`), env, ctx);
    expect(res.status).toBe(304);
  });

  test("GET with non-matching If-None-Match returns 200 with body", async () => {
    const res = await worker.fetch(getReq('"someothertag"'), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(StubR2Bucket.ETAG);
    expect(await res.text()).toBe(StubR2Bucket.BODY);
  });

  test("GET without If-None-Match returns 200 with body", async () => {
    const res = await worker.fetch(getReq(), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(StubR2Bucket.BODY);
  });
});
