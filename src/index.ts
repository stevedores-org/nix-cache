/**
 * Nix Binary Cache Worker for Cloudflare R2
 *
 * This worker implements a Nix-compatible binary cache backed by Cloudflare R2.
 * It serves .narinfo and .nar files.
 */

export interface Env {
  BUCKET: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Nix cache health check
    if (path === "/" || path === "/nix-cache-info") {
      return new Response(
        "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n",
        {
          headers: { "Content-Type": "text/x-nix-cache-info" },
        }
      );
    }

    // Health check for status monitoring
    if (path === "/health") {
      return new Response(JSON.stringify({
        status: "ok",
        cache: "nix-cache",
        timestamp: new Date().toISOString()
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // GET requests - serve from R2
    if (request.method === "GET") {
      const objectName = path.startsWith("/") ? path.slice(1) : path;
      const object = await env.BUCKET.get(objectName);

      if (!object) {
        return new Response("Not found", { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);

      // Set correct content types for Nix files
      if (path.endsWith(".narinfo")) {
        headers.set("Content-Type", "text/x-nix-narinfo");
      } else if (path.endsWith(".nar") || path.includes("/nar/")) {
        headers.set("Content-Type", "application/x-nix-archive");
      }

      return new Response(object.body, {
        headers,
      });
    }

    // PUT requests - upload to R2 (requires secret/token validation in production)
    if (request.method === "PUT") {
      // Basic auth or token validation should be added here
      const authHeader = request.headers.get("Authorization");
      if (!authHeader) {
        return new Response("Unauthorized", { status: 401 });
      }

      const objectName = path.startsWith("/") ? path.slice(1) : path;
      await env.BUCKET.put(objectName, request.body, {
        httpMetadata: request.headers,
      });

      return new Response("OK", { status: 201 });
    }

    return new Response("Method not allowed", { status: 405 });
  },
};
