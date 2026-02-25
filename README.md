# nix-cache

Nix binary cache Cloudflare Worker backed by R2 storage.

**Live:** https://nix-cache.stevedores.org

## What is this?

A **plain Nix binary cache** (not [Attic](https://github.com/zhaofengli/attic)) backed by Cloudflare R2. It implements the standard Nix binary cache protocol — `nix-cache-info`, `.narinfo`, and `.nar` files served over HTTPS.

**This is NOT an Attic server.** Use `nix copy --to` for uploads, not `attic push`. The `attic-client` package is not needed.

## Architecture

```
┌─────────────┐     ┌─────────────────────┐     ┌──────────┐
│  Nix Client │────▶│  Cloudflare Worker  │────▶│  R2 Bucket│
└─────────────┘     └─────────────────────┘     └──────────┘
                    nix-cache.stevedores.org     nix-cache
```

- **Worker**: Routes requests, sets correct MIME types
- **R2**: Stores `.narinfo` (metadata) and `.nar` (archives) files

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
      "stevedores-cache-1:bXLxkipycRWproIJnk8pPWNFdgVfeV+I2mJXCoW4/ag="
    ];
  };
}
```

**Flakes** (`flake.nix`):
```nix
{
  nixConfig = {
    extra-substituters = [ "https://nix-cache.stevedores.org" ];
    extra-trusted-public-keys = [ "stevedores-cache-1:bXLxkipycRWproIJnk8pPWNFdgVfeV+I2mJXCoW4/ag=" ];
  };
}
```

**Command line**:
```bash
nix build --substituters "https://cache.nixos.org https://nix-cache.stevedores.org" .#package
```

### For OCI/Container Builds

When building container images with Nix:

```bash
# Build with custom cache
nix build .#dockerImage \
  --substituters "https://cache.nixos.org https://nix-cache.stevedores.org"

# Load into Docker
docker load < result
```

Or in a CI pipeline:
```yaml
- name: Build container
  run: |
    nix build .#dockerImage \
      --substituters "https://cache.nixos.org https://nix-cache.stevedores.org" \
      --trusted-public-keys "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY= stevedores-cache-1:bXLxkipycRWproIJnk8pPWNFdgVfeV+I2mJXCoW4/ag="
```

## Pushing to the Cache

Upload pre-built packages after CI builds using `nix copy` (the standard Nix protocol):

```bash
# Sign and upload a store path
nix store sign --key-file /path/to/secret-key /nix/store/abc123-mypackage
nix copy --to "http://nix-cache.stevedores.org?secret-key=/path/to/secret-key" /nix/store/abc123-mypackage
```

In CI (using org secrets):
```bash
echo "$NIX_SIGNING_SECRET_KEY" > /tmp/nix-sign-key
nix copy --to "http://nix-cache.stevedores.org?secret-key=/tmp/nix-sign-key" .#packages.x86_64-linux.default
```

**Note:** PUT requests require `Authorization: Bearer <CACHE_AUTH_TOKEN>` header.

> **Do NOT use `attic push`** — this is a plain binary cache, not an Attic server.
> The `attic-client` devShell dependency can be removed from consuming repos.

## Reusable GitHub Actions

This repo provides composite actions for CI integration.

### Setup (pull from cache)

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: stevedores-org/nix-cache/.github/actions/setup@develop
        with:
          push: ${{ github.event_name == 'push' }}
          cache-auth-token: ${{ secrets.CACHE_AUTH_TOKEN }}
          signing-secret-key: ${{ secrets.NIX_SIGNING_SECRET_KEY }}

      - run: nix flake check

      # Push build results (only on merge, when push=true was set)
      - uses: stevedores-org/nix-cache/.github/actions/push@develop
        if: github.event_name == 'push'
        with:
          paths: .#default
```

### Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `push` | No | Enable cache uploads (default: `false`) |
| `cache-auth-token` | If push | Bearer token for PUT auth |
| `signing-secret-key` | If push | Ed25519 secret key for signing |

All secrets are available as `stevedores-org` org-level secrets.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Cache info |
| `/nix-cache-info` | GET | Cache info |
| `/health` | GET | Health check (JSON) |
| `/<hash>.narinfo` | GET | Package metadata |
| `/nar/<hash>.nar` | GET | Package archive |
| `/*` | PUT | Upload (requires auth) |

## Development

```bash
# Install deps
bun install

# Run locally
bunx wrangler dev

# Deploy
bunx wrangler deploy
```

## Cloudflare Setup

1. Create R2 bucket named `nix-cache`
2. Add custom domain `nix-cache.stevedores.org`
3. Deploy worker with `wrangler deploy`

## Signing Key

**Public key:** `stevedores-cache-1:bXLxkipycRWproIJnk8pPWNFdgVfeV+I2mJXCoW4/ag=`

The secret key is stored as `NIX_SIGNING_SECRET_KEY` in the `stevedores-org` GitHub org secrets.

To rotate the key:
```bash
nix-store --generate-binary-cache-key stevedores-cache-2 /path/to/secret /path/to/public
# Update org secret NIX_SIGNING_SECRET_KEY and NIX_SIGNING_PUBLIC_KEY
# Update this README and all consuming flake.nix files
```

## License

MIT
