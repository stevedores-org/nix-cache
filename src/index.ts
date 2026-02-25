/**
 * Nix Binary Cache Worker for Cloudflare R2
 *
 * Implements a Nix-compatible binary cache backed by Cloudflare R2.
 * GET is public (serves .narinfo and .nar files).
 * PUT requires Bearer token authentication.
 */

export interface Env {
  BUCKET: R2Bucket;
  CACHE_AUTH_TOKEN: string;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Nix cache info
    if (path === "/" || path === "/nix-cache-info") {
      return new Response(
        "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n",
        {
          headers: { "Content-Type": "text/x-nix-cache-info" },
        }
      );
    }

    // Health check
    if (path === "/health") {
      return new Response(JSON.stringify({
        status: "ok",
        cache: "nix-cache",
        timestamp: new Date().toISOString()
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // GET — public, serve from R2
    if (request.method === "GET") {
      const objectName = path.startsWith("/") ? path.slice(1) : path;
      const object = await env.BUCKET.get(objectName);

      if (!object) {
        return new Response("Not found", { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);

      if (path.endsWith(".narinfo")) {
        headers.set("Content-Type", "text/x-nix-narinfo");
      } else if (path.endsWith(".nar") || path.includes("/nar/")) {
        headers.set("Content-Type", "application/x-nix-archive");
      }

      return new Response(object.body, { headers });
    }

    // PUT — requires Bearer token
    if (request.method === "PUT") {
      if (!env.CACHE_AUTH_TOKEN) {
        return jsonError("Server misconfigured: no auth token set", 500);
      }

      const authHeader = request.headers.get("Authorization");
      if (!authHeader) {
        return jsonError("Missing Authorization header", 401);
      }

      const [scheme, token] = authHeader.split(" ", 2);
      if (scheme !== "Bearer" || !token) {
        return jsonError("Authorization must use Bearer scheme", 401);
      }

      if (token !== env.CACHE_AUTH_TOKEN) {
        return jsonError("Invalid token", 403);
      }

      const objectName = path.startsWith("/") ? path.slice(1) : path;
      await env.BUCKET.put(objectName, request.body, {
        httpMetadata: request.headers,
      });

      return new Response("OK", { status: 201 });
    }

    return jsonError("Method not allowed", 405);
  },
};
