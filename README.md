# nix-cache

Nix binary cache Cloudflare Worker backed by R2 storage.

**Live:** https://nix-cache.stevedores.org

## What is this?

A Nix-compatible binary cache that serves pre-built Nix packages. Instead of building everything from source, Nix can download pre-built binaries from this cache.

## Architecture

```
┌─────────────┐     ┌─────────────────────┐     ┌──────────┐
│  Nix Client │────▶│  Cloudflare Worker  │────▶│  R2 Bucket│
└─────────────┘     └─────────────────────┘     └──────────┘
                    nix-cache.stevedores.org     nix-cache
```

- **Worker**: routing, edge cache, range requests, signature verification, constant-time auth
- **R2**: stores `.narinfo` (metadata) and `.nar` (archives) files

Hash-named paths only: `[0-9a-z]{32}\.narinfo` and `nar/[0-9a-z]{52}…\.nar(\.(xz|zst|bz2|br))?`. Anything else is rejected.

## Usage

### Add to your Nix configuration

**NixOS** (`/etc/nixos/configuration.nix`):
```nix
{
  nix.settings = {
    substituters = [
      "https://cache.nixos.org"
      "https://nix-cache.stevedores.org"
    ];
    trusted-public-keys = [
      "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
      # Add your cache's public key here
    ];
  };
}
```

**Flakes** (`flake.nix`):
```nix
{
  nixConfig = {
    extra-substituters = [ "https://nix-cache.stevedores.org" ];
    extra-trusted-public-keys = [ "your-key-here" ];
  };
}
```

**Command line**:
```bash
nix build --substituters "https://cache.nixos.org https://nix-cache.stevedores.org" .#package
```

## Pushing to the Cache

Uploads require an `UPLOAD_TOKEN` (set as a Cloudflare secret). If `NIX_PUBLIC_KEY` is also set, the worker verifies every `.narinfo` against the configured Ed25519 public key and rejects unsigned or mismatched uploads.

Two auth styles are accepted:

**Basic (Nix-native, works with `nix copy --to`):**

```bash
nix store sign --key-file /path/to/secret-key /nix/store/abc123-mypackage
nix copy --to "https://uploader:$UPLOAD_TOKEN@nix-cache.stevedores.org" /nix/store/abc123-mypackage
```

The username is ignored; only the password (token) is checked.

**Bearer (for `curl` or generic HTTP clients):**

```bash
curl -X PUT -H "Authorization: Bearer $UPLOAD_TOKEN" \
  --data-binary @abc123.narinfo \
  https://nix-cache.stevedores.org/abc123.narinfo
```

## API Endpoints

| Endpoint              | Method     | Description                                |
|-----------------------|------------|--------------------------------------------|
| `/nix-cache-info`     | GET        | Cache info (cached 1h)                     |
| `/health`             | GET        | Health check (JSON)                        |
| `/<hash>.narinfo`     | GET / HEAD | Package metadata (immutable, range-able)   |
| `/nar/<hash>.nar`     | GET / HEAD | Package archive (immutable, range-able)    |
| `/<hash>.narinfo`     | PUT        | Upload narinfo (auth + signature required) |
| `/nar/<hash>.nar(.*)` | PUT        | Upload NAR archive (auth required)         |

GET responses are tagged `Cache-Control: public, max-age=31536000, immutable` and replicated to Cloudflare's edge cache on first hit. `Range` requests get `206 Partial Content`; `If-None-Match` works through edge cache revalidation.

## Development

```bash
bun install
bunx wrangler dev      # local dev
bun run typecheck      # tsc --noEmit
bunx wrangler deploy   # ship to Cloudflare
```

## Cloudflare Setup

1. Create R2 bucket named `nix-cache`.
2. Add custom domain `nix-cache.stevedores.org`.
3. Set secrets:
   ```bash
   wrangler secret put UPLOAD_TOKEN      # required for PUTs to work
   wrangler secret put NIX_PUBLIC_KEY    # optional, enforces signed narinfo
   ```
4. `wrangler deploy`.

Without `UPLOAD_TOKEN`, PUT returns `503 Uploads disabled` — the cache is read-only.

## Generating Cache Keys

```bash
nix-store --generate-binary-cache-key nix-cache.stevedores.org-1 secret-key public-key
# secret-key: keep safe, used for signing
# public-key: set as NIX_PUBLIC_KEY secret, distribute to clients in trusted-public-keys
```

## License

MIT
