/**
 * Nix Binary Cache Worker for Cloudflare R2
 *
 * Implements a Nix-compatible binary cache backed by Cloudflare R2.
 * Serves .narinfo and .nar files with edge caching, range requests,
 * Ed25519 signature verification on uploads, and constant-time
 * token auth.
 */

export interface Env {
  BUCKET: R2Bucket;
  UPLOAD_TOKEN?: string;
  NIX_PUBLIC_KEY?: string;
}

const NIX_CACHE_INFO = "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n";

// Hash-named paths only — keeps the bucket clean and prevents path injection.
const NARINFO_RE = /^[0-9a-z]{32}\.narinfo$/;
const NAR_RE = /^nar\/[0-9a-z]{52}(-[0-9a-z+._-]+)?\.nar(\.(xz|zst|bz2|br))?$/;

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

// Per-isolate cache of the imported Ed25519 key. Cloudflare reloads the isolate
// on secret updates and deploys, so invalidation is implicit.
let publicKeyCache: { keyName: string; key: CryptoKey } | null = null;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      return Response.json({
        status: "ok",
        cache: "nix-cache",
        timestamp: new Date().toISOString(),
      });
    }

    const method = request.method;
    if (method === "GET" || method === "HEAD") return handleRead(request, env, ctx);
    if (method === "PUT") return handleUpload(request, env);

    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD, PUT" },
    });
  },
};

async function handleRead(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const objectName = url.pathname.slice(1);

  if (!isValidPath(objectName)) {
    return new Response("Not found", { status: 404 });
  }

  // HEAD: check edge cache for a matching GET response first. If found,
  // return a body-less 200 with the cached headers. This avoids a round-trip
  // to R2 for already-warmed hashes.
  if (request.method === "HEAD") {
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      return new Response(null, { status: 200, headers: cached.headers });
    }

    const head = await env.BUCKET.head(objectName);
    if (!head) return new Response(null, { status: 404 });
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
  // bypasses it and goes to R2 for a 206. Reject multi-range with 416
  // (was a silent full-body 200 before); accept the suffix form
  // `bytes=-N` (was treated as no-range, pulling the whole object).
  const parsedRange = parseRangeHeader(request.headers.get("range"));
  if (parsedRange?.kind === "invalid") {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { "Accept-Ranges": "bytes" },
    });
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

  // Edge cache: hash-named, immutable full-object GETs only.
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (parsedRange === null) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const object = await env.BUCKET.get(objectName, r2Opts);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  setContentType(headers, objectName);
  headers.set("Cache-Control", IMMUTABLE_CACHE);
  headers.set("Accept-Ranges", "bytes");

  let status = 200;
  if (parsedRange !== null) {
    let start: number;
    let length: number;
    if (parsedRange.kind === "prefix") {
      start = parsedRange.offset;
      length = parsedRange.length ?? object.size - start;
    } else {
      // suffix: clamp to size when N >= size (RFC 9110 §14.1.2)
      length = Math.min(parsedRange.length, object.size);
      start = object.size - length;
    }
    headers.set(
      "Content-Range",
      `bytes ${start}-${start + length - 1}/${object.size}`,
    );
    headers.set("Content-Length", String(length));
    status = 206;
  } else {
    headers.set("Content-Length", String(object.size));
  }

  const response = new Response(object.body, { status, headers });

  // Only cache full 200 responses — partials would pollute the edge cache.
  // Failures (body too large for cache.put, transient backpressure, …) are
  // logged via console.error so they show up in `wrangler tail`. Without
  // this, a put that silently fails turns every request into a cold R2 read
  // forever with no warning.
  if (status === 200) {
    ctx.waitUntil(
      cache.put(cacheKey, response.clone()).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `cache.put failed for ${objectName} (size=${object.size}): ${message}`,
        );
      }),
    );
  }

  return response;
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  if (!env.UPLOAD_TOKEN) {
    return new Response("Uploads disabled", { status: 503 });
  }

  const provided = extractAuthToken(request.headers.get("authorization"));
  if (!provided || !constantTimeEqual(provided, env.UPLOAD_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
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

  return new Response("OK", { status: 201 });
}

function extractAuthToken(authHeader: string | null): string {
  if (!authHeader) return "";
  if (authHeader.startsWith("Bearer ")) return authHeader.slice(7).trim();
  if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = atob(authHeader.slice(6).trim());
      const colonIdx = decoded.indexOf(":");
      return colonIdx === -1 ? "" : decoded.slice(colonIdx + 1);
    } catch {
      return "";
    }
  }
  return "";
}

function isValidPath(p: string): boolean {
  return NARINFO_RE.test(p) || NAR_RE.test(p);
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

  const suffix = /^bytes=-(\d+)$/.exec(header);
  if (suffix) {
    const length = parseInt(suffix[1], 10);
    return length > 0 ? { kind: "suffix", length } : { kind: "invalid" };
  }

  const single = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (single) {
    const offset = parseInt(single[1], 10);
    if (!single[2]) return { kind: "prefix", offset };
    const end = parseInt(single[2], 10);
    if (end < offset) return { kind: "invalid" };
    return { kind: "prefix", offset, length: end - offset + 1 };
  }

  return null; // unrecognised — caller treats as no Range
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
    const key = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    publicKeyCache = { keyName, key };
  }

  const fields: Record<string, string> = {};
  const sigs: string[] = [];
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k === "Sig") sigs.push(v);
    else fields[k] = v;
  }

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
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKeyCache.key,
      sigBytes,
      fingerprintBytes,
    );
    if (ok) return true;
  }
  return false;
}

function base64Decode(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
