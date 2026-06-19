/**
 * Nix Binary Cache Worker for Cloudflare R2
 *
 * Implements a Nix-compatible binary cache backed by Cloudflare R2.
 * Serves .narinfo and .nar files with edge caching, range requests,
 * Ed25519 signature verification on uploads, constant-time token auth,
 * and Cloudflare KV-backed metrics.
 * GET is public (serves .narinfo and .nar files).
 * PUT requires Bearer token authentication.
 * /metrics returns JSON counters (authenticated).
 */

export interface Env {
  BUCKET: R2Bucket;
  UPLOAD_TOKEN?: string;
  CACHE_AUTH_TOKEN?: string;
  NIX_PUBLIC_KEY?: string;
  METRICS?: KVNamespace;
}

type MetricKey = "get_hit" | "get_miss" | "put_ok" | "auth_fail";

async function incMetric(kv: KVNamespace | undefined, key: MetricKey): Promise<void> {
  if (!kv) return;
  const val = parseInt((await kv.get(key)) || "0", 10);
  await kv.put(key, String(val + 1));
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bearerAuth(request: Request, env: Env): Response | null {
  const token = env.CACHE_AUTH_TOKEN || env.UPLOAD_TOKEN;
  if (!token) {
    return jsonError("Server misconfigured: no auth token set", 500);
  }
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return jsonError("Missing Authorization header", 401);
  }
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
    return jsonError("Authorization must use Bearer scheme", 401);
  }
  const provided = parts[1];
  if (!constantTimeEqual(provided, token)) {
    return jsonError("Invalid token", 403);
  }
  return null;
}

const NIX_CACHE_INFO = "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n";

// Hash-named paths only — keeps the bucket clean and prevents path injection.
const NARINFO_RE = /^(?:[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+\.narinfo$/;
const NAR_RE = /^(?:[a-zA-Z0-9._-]+\/)?nar\/[a-zA-Z0-9._-]+\.nar(\.(xz|zst|bz2|br))?$/;

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

// Objects this large or larger won't fit in the Cache API's per-entry body
// limit. Putting them anyway silently fails — the put rejects after the
// body is uploaded — and every subsequent request reads from R2 cold.
// Skipping the put outright + logging is the smallest fix; the longer-term
// path is to serve /nar/* via an R2 Custom Domain so the worker is out of
// the egress path for large objects entirely (#24).
const CACHE_PUT_BYTE_LIMIT = 50 * 1024 * 1024; // 50 MB; conservative

// Per-isolate cache of the imported Ed25519 key. Cloudflare reloads the isolate
// on secret updates and deploys, so invalidation is implicit.
let publicKeyCache: { keyName: string; key: CryptoKey } | null = null;

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const context = ctx ?? ({ waitUntil: () => {} } as unknown as ExecutionContext);
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "/nix-cache-info") {
      return new Response(NIX_CACHE_INFO, {
        headers: {
          "Content-Type": "text/x-nix-cache-info",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    if (path === "/health") {
      return Response.json(
        {
          status: "ok",
          cache: "nix-cache",
          timestamp: new Date().toISOString(),
        },
        // `timestamp` changes every request; intermediates must not serve
        // a stale snapshot as a "live" health check.
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (path === "/metrics") {
      const authErr = bearerAuth(request, env);
      if (authErr) {
        context.waitUntil(incMetric(env.METRICS, "auth_fail"));
        return authErr;
      }

      const keys: MetricKey[] = ["get_hit", "get_miss", "put_ok", "auth_fail"];
      const metrics: Record<string, number> = {};
      for (const k of keys) {
        metrics[k] = parseInt((await env.METRICS?.get(k)) || "0", 10);
      }
      metrics.get_total = metrics.get_hit + metrics.get_miss;

      return new Response(JSON.stringify(metrics, null, 2), {
        headers: {
          "Content-Type": "application/json",
          // Counters mutate on every cache request; intermediates must not
          // serve a stale snapshot. Without this, a CDN edge could pin
          // numbers for an operator's dashboard.
          "Cache-Control": "no-store",
        },
      });
    }

    const method = request.method;
    if (method === "GET" || method === "HEAD") {
      const response = await handleRead(request, env, context);
      // Classification: the resource existing in R2 is a hit (200/206/304/416
      // — 416 means the object was there but the requested byte range was
      // not satisfiable, which is a client-side range error, not a miss).
      // 404 is the only true miss. Other statuses (e.g. 5xx) are not
      // request-outcome events and are deliberately not counted.
      if (response.status === 200 || response.status === 206 || response.status === 304 || response.status === 416) {
        context.waitUntil(incMetric(env.METRICS, "get_hit"));
      } else if (response.status === 404) {
        context.waitUntil(incMetric(env.METRICS, "get_miss"));
      }
      return response;
    }

    if (method === "PUT") {
      return handleUpload(request, env, context);
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        Allow: "GET, HEAD, PUT",
      },
    });
  },
};

async function handleRead(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const objectName = url.pathname.slice(1);

  if (!isValidPath(objectName)) {
    return new Response("Not found", { status: 404 });
  }

  // HEAD: check edge cache for a matching GET response first. If found,
  // return a body-less 200 with the cached headers. This avoids a round-trip
  // to R2 for already-warmed hashes.
  if (request.method === "HEAD") {
    // RFC 9110 §13.1.2: a conditional HEAD with `If-None-Match` matching the
    // current representation MUST respond 304, not 200. Without this, clients
    // can't use HEAD as a freshness probe — they have to issue a GET and
    // discard the body.
    const headIfNoneMatch = request.headers.get("if-none-match");
    const headConditionalEtag = headIfNoneMatch ? normalizeEtag(headIfNoneMatch) : undefined;

    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      if (headConditionalEtag) {
        const cachedEtag = normalizeEtag(cached.headers.get("etag") ?? "");
        if (cachedEtag === headConditionalEtag) {
          return new Response(null, {
            status: 304,
            headers: {
              etag: cached.headers.get("etag") ?? headConditionalEtag,
              "Cache-Control": IMMUTABLE_CACHE,
            },
          });
        }
      }
      return new Response(null, { status: 200, headers: cached.headers });
    }

    const head = await env.BUCKET.head(objectName);
    if (!head) return new Response(null, { status: 404 });

    if (headConditionalEtag && normalizeEtag(head.httpEtag) === headConditionalEtag) {
      return new Response(null, {
        status: 304,
        headers: {
          etag: head.httpEtag,
          "Cache-Control": IMMUTABLE_CACHE,
        },
      });
    }

    const headers = new Headers();
    head.writeHttpMetadata(headers);
    headers.set("etag", head.httpEtag);
    setContentType(headers, objectName);
    headers.set("Cache-Control", IMMUTABLE_CACHE);
    headers.set("Content-Length", String(head.size));
    headers.set("Accept-Ranges", "bytes");
    return new Response(null, { status: 200, headers });
  }

  // Parse Range header. Cache stores full 200s only, so any range form
  // bypasses it and goes to R2 for a 206. Reject multi-range with 416;
  // accept the suffix form `bytes=-N`.
  const parsedRange = parseRangeHeader(request.headers.get("range"));
  if (parsedRange?.kind === "invalid") {
    // Pre-R2: object size unknown, so the `Content-Range` header is omitted.
    return rangeNotSatisfiable();
  }

  const r2Opts: R2GetOptions = {};
  if (parsedRange?.kind === "prefix") {
    r2Opts.range =
      parsedRange.length !== undefined
        ? { offset: parsedRange.offset, length: parsedRange.length }
        : { offset: parsedRange.offset };
  } else if (parsedRange?.kind === "suffix") {
    r2Opts.range = { suffix: parsedRange.length };
  }

  // Forward If-None-Match to R2 on full (non-range) GETs only after an edge
  // cache miss. Warm cache hits stay on the edge path; the conditional
  // comparison is handled from the cached response headers.
  const ifNoneMatch = request.headers.get("if-none-match");
  const conditionalEtag = parsedRange === null && ifNoneMatch ? normalizeEtag(ifNoneMatch) : undefined;
  if (conditionalEtag) {
    r2Opts.onlyIf = { etagDoesNotMatch: conditionalEtag };
  }

  // Edge cache: hash-named, immutable full-object GETs only.
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (parsedRange === null) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return respondFromCache(cached, conditionalEtag);
    }
  }

  const object = await env.BUCKET.get(objectName, r2Opts);
  if (!object) {
    // R2 returns null for missing keys OR ranges past the end of an object
    // OR if the onlyIf condition failed. Disambiguate via HEAD.
    const head = await env.BUCKET.head(objectName);
    if (head) {
      // Path 1: Conditional GET matched (304). `head.httpEtag` is quoted but
      // `conditionalEtag` is normalized (unquoted), so normalize before
      // comparing — mirrors the HEAD path above. Without this, a matching
      // conditional GET fell through to 404 instead of 304.
      if (conditionalEtag && normalizeEtag(head.httpEtag) === conditionalEtag) {
        return new Response(null, {
          status: 304,
          headers: {
            etag: head.httpEtag,
            "Cache-Control": IMMUTABLE_CACHE,
          },
        });
      }
      // Path 2: Range request was out of bounds (416).
      if (parsedRange?.kind === "prefix" || parsedRange?.kind === "suffix") {
        return rangeNotSatisfiable(head.size);
      }
    }
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  setContentType(headers, objectName);
  headers.set("Cache-Control", IMMUTABLE_CACHE);
  headers.set("Accept-Ranges", "bytes");

  let status = 200;
  if (parsedRange?.kind === "prefix" || parsedRange?.kind === "suffix") {
    const outcome = resolveRange(parsedRange, object.size);
    if (outcome.kind === "unsatisfiable") {
      return rangeNotSatisfiable(object.size);
    }
    headers.set("Content-Range", `bytes ${outcome.start}-${outcome.start + outcome.length - 1}/${object.size}`);
    headers.set("Content-Length", String(outcome.length));
    status = 206;
  } else {
    headers.set("Content-Length", String(object.size));
  }

  const response = new Response(object.body, { status, headers });

  // Only cache full 200 responses — partials would pollute the edge cache.
  // Two failure modes, two defences:
  //   1. Body above the Cache API per-entry limit → skip the put outright
  //      (the request would otherwise pay for the body clone + a wasted
  //      background upload that silently rejects).
  //   2. Anything below the limit that still rejects (transient backpressure,
  //      network blips) → log via console.error so it shows up in
  //      `wrangler tail` instead of vanishing.
  // Path A (R2 Custom Domain for /nar/*) is the longer-term fix for (1).
  if (status === 200) {
    if (object.size >= CACHE_PUT_BYTE_LIMIT) {
      console.log(`cache.put skipped for ${objectName} (size=${object.size} >= limit=${CACHE_PUT_BYTE_LIMIT})`);
    } else {
      ctx.waitUntil(
        cache.put(cacheKey, response.clone()).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`cache.put failed for ${objectName} (size=${object.size}): ${message}`);
        }),
      );
    }
  }

  return response;
}

async function handleUpload(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const authErr = bearerAuth(request, env);
  if (authErr) {
    ctx.waitUntil(incMetric(env.METRICS, "auth_fail"));
    return authErr;
  }

  const url = new URL(request.url);
  const objectName = url.pathname.slice(1);
  if (!isValidPath(objectName)) {
    return new Response("Invalid path", { status: 400 });
  }

  // Whitelist headers copied into R2 metadata — never copy auth or host headers wholesale.
  const httpMetadata: R2HTTPMetadata = {};
  const ct = request.headers.get("content-type");
  if (ct) httpMetadata.contentType = ct;
  const ce = request.headers.get("content-encoding");
  if (ce) httpMetadata.contentEncoding = ce;

  // Signature verification (narinfo only — NARs are referenced by content hash in the narinfo).
  if (NARINFO_RE.test(objectName) && env.NIX_PUBLIC_KEY) {
    const text = await request.text();
    const ok = await verifyNarinfo(text, env.NIX_PUBLIC_KEY);
    if (!ok) {
      return new Response("Invalid or missing signature", { status: 400 });
    }
    await env.BUCKET.put(objectName, text, { httpMetadata });
  } else {
    await env.BUCKET.put(objectName, request.body, { httpMetadata });
  }

  ctx.waitUntil(incMetric(env.METRICS, "put_ok"));
  return new Response("OK", { status: 201 });
}

function isValidPath(p: string): boolean {
  return NARINFO_RE.test(p) || NAR_RE.test(p);
}

/**
 * Build a 416 Range Not Satisfiable response.
 *
 * When `objectSize` is known, includes `Content-Range: bytes * /<size>` per
 * RFC 9110 §15.5.17. The pre-R2 invalid-syntax path (multi-range, inverted,
 * zero-suffix) doesn't know the size and omits the header.
 *
 * The 416 is response-cacheable for hash-named immutable content: given
 * (hash, range), the 416 is itself stable. Same `Cache-Control` as the
 * 206/200 paths so the edge cache treats all responses for a hash uniformly.
 */
function rangeNotSatisfiable(objectSize?: number): Response {
  const headers: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Cache-Control": IMMUTABLE_CACHE,
  };
  if (objectSize !== undefined) {
    headers["Content-Range"] = `bytes */${objectSize}`;
  }
  return new Response("Range Not Satisfiable", { status: 416, headers });
}

/**
 * Parsed shape of an HTTP Range header for a single-range read.
 *
 * - `prefix`     — `bytes=N-` or `bytes=N-M`. `length` undefined means "to end".
 * - `suffix`     — `bytes=-N`. Last N bytes of the object.
 * - `invalid`    — multi-range, inverted range, or zero-length suffix.
 *                  Callers MUST respond with 416 Range Not Satisfiable.
 *
 * Returns `null` for `null` header or unrecognised malformed syntax,
 * in which case the caller treats it as no Range header (RFC 9110 §14.2).
 */
export type ParsedRange =
  | { kind: "prefix"; offset: number; length?: number }
  | { kind: "suffix"; length: number }
  | { kind: "invalid" };

export function parseRangeHeader(header: string | null): ParsedRange | null {
  if (!header) return null;

  // Multi-range: a comma anywhere in the byte ranges. We don't support it —
  // R2 single-range is enough for narinfo/NAR access patterns.
  if (header.includes(",")) {
    return { kind: "invalid" };
  }

  // `parseInt` on a digit string longer than ~16 chars produces a value past
  // Number.MAX_SAFE_INTEGER, at which point arithmetic (`end - offset + 1`)
  // silently loses precision. Treat that as a malformed range so callers
  // get a deterministic 416 instead of a quietly-wrong Content-Length.
  const safe = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

  const suffix = /^bytes=-(\d+)$/.exec(header);
  if (suffix) {
    const length = parseInt(suffix[1], 10);
    return length > 0 && safe(length) ? { kind: "suffix", length } : { kind: "invalid" };
  }

  const single = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (single) {
    const offset = parseInt(single[1], 10);
    if (!safe(offset)) return { kind: "invalid" };
    if (!single[2]) return { kind: "prefix", offset };
    const end = parseInt(single[2], 10);
    if (!safe(end) || end < offset) return { kind: "invalid" };
    const length = end - offset + 1;
    if (!safe(length)) return { kind: "invalid" };
    return { kind: "prefix", offset, length };
  }

  return null; // unrecognised — caller treats as no Range
}

/**
 * The two `ParsedRange` shapes that can be sent to R2 (i.e. not `invalid`).
 * `resolveRange` accepts this narrowed type so the unsatisfiable detection
 * is purely about size, not syntax.
 */
export type RangeRequest = { kind: "prefix"; offset: number; length?: number } | { kind: "suffix"; length: number };

/**
 * Result of intersecting a parsed range with the object's actual size.
 *
 * - `satisfied`     — `start` (inclusive) + `length` resolve to bytes that
 *                     exist in the object. The caller uses these to build
 *                     `Content-Range` and `Content-Length`.
 * - `unsatisfiable` — the range references bytes the object doesn't have
 *                     (offset >= size, or zero-suffix). Caller MUST respond
 *                     with 416 + `Content-Range: bytes * /<size>`.
 *
 * The end of the served byte run is `start + length - 1`. For prefix ranges
 * whose explicit end exceeds the object, the end is clamped to `size - 1`
 * per RFC 9110 §14.1.2. For suffix ranges where N >= size, the whole object
 * is served.
 */
export type RangeOutcome = { kind: "satisfied"; start: number; length: number } | { kind: "unsatisfiable" };

export function resolveRange(req: RangeRequest, objectSize: number): RangeOutcome {
  // RFC 9110 §14.1.2: a byte-range-set is satisfiable iff at least one spec
  // identifies bytes that exist. An empty object has none.
  if (objectSize === 0) return { kind: "unsatisfiable" };

  if (req.kind === "prefix") {
    if (req.offset >= objectSize) return { kind: "unsatisfiable" };
    const end = req.length !== undefined ? Math.min(req.offset + req.length - 1, objectSize - 1) : objectSize - 1;
    return { kind: "satisfied", start: req.offset, length: end - req.offset + 1 };
  }
  // suffix
  if (req.length === 0) return { kind: "unsatisfiable" };
  const length = Math.min(req.length, objectSize);
  return { kind: "satisfied", start: objectSize - length, length };
}

/**
 * Decide whether to serve a 304 or return the cached response based on the
 * client's conditional etag.
 */
export function respondFromCache(cached: Response, conditionalEtag?: string): Response {
  if (conditionalEtag) {
    const cachedEtag = normalizeEtag(cached.headers.get("etag") ?? "");
    if (cachedEtag === conditionalEtag) {
      return new Response(null, {
        status: 304,
        headers: {
          etag: cached.headers.get("etag") ?? conditionalEtag,
          "Cache-Control": IMMUTABLE_CACHE,
        },
      });
    }
  }

  return cached;
}

export function normalizeEtag(value: string): string {
  const stripped = value.replace(/^W\//, "");
  const m = /^"(.*)"$/.exec(stripped);
  return m ? m[1] : stripped;
}

function setContentType(headers: Headers, path: string): void {
  if (path.endsWith(".narinfo")) {
    headers.set("Content-Type", "text/x-nix-narinfo");
  } else if (path.includes(".nar")) {
    headers.set("Content-Type", "application/x-nix-archive");
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Parse narinfo text into scalar fields + signatures.
 *
 * Non-`Sig` fields must appear at most once. Nix libstore uses LAST-WINS for
 * some duplicates (StorePath/NarHash/NarSize) but errors on others
 * (References/CA). We reject all duplicate non-`Sig` keys at upload time so
 * the verifier fingerprint cannot diverge from what a Nix client interprets
 * from the same bytes. `Sig` remains multi-valued.
 */
export function parseNarinfoFields(
  text: string,
): { ok: true; fields: Record<string, string>; sigs: string[] } | { ok: false } {
  const fields: Record<string, string> = {};
  const sigs: string[] = [];
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k === "Sig") {
      sigs.push(v);
    } else if (k in fields) {
      return { ok: false };
    } else {
      fields[k] = v;
    }
  }
  return { ok: true, fields, sigs };
}

async function verifyNarinfo(text: string, nixPublicKey: string): Promise<boolean> {
  if (!publicKeyCache) {
    const colonIdx = nixPublicKey.indexOf(":");
    if (colonIdx === -1) return false;
    const keyName = nixPublicKey.slice(0, colonIdx);
    let raw: Uint8Array;
    try {
      raw = base64Decode(nixPublicKey.slice(colonIdx + 1));
    } catch {
      return false;
    }
    if (raw.length !== 32) return false;
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    publicKeyCache = { keyName, key };
  }

  const parsed = parseNarinfoFields(text);
  if (!parsed.ok) return false;
  const { fields, sigs } = parsed;

  const refs = (fields["References"] ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((r) => `/nix/store/${r}`)
    .join(",");
  const fingerprint = `1;${fields["StorePath"]};${fields["NarHash"]};${fields["NarSize"]};${refs}`;
  const fingerprintBytes = new TextEncoder().encode(fingerprint);

  for (const sig of sigs) {
    const colonIdx = sig.indexOf(":");
    if (colonIdx === -1) continue;
    const name = sig.slice(0, colonIdx);
    if (name !== publicKeyCache.keyName) continue;
    let sigBytes: Uint8Array;
    try {
      sigBytes = base64Decode(sig.slice(colonIdx + 1));
    } catch {
      continue;
    }
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, publicKeyCache.key, sigBytes, fingerprintBytes);
    if (ok) return true;
  }
  return false;
}

function base64Decode(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
