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
      --trusted-public-keys "cache.nixos.org-1:... your-key:..."
```

## Pushing to the Cache

Upload pre-built packages after CI builds:

```bash
# Sign and upload a store path
nix store sign --key-file /path/to/secret-key /nix/store/abc123-mypackage
nix copy --to "https://nix-cache.stevedores.org" /nix/store/abc123-mypackage
```

**Note:** PUT requests require `Authorization` header.

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

## Generating Cache Keys

```bash
# Generate signing key pair
nix-store --generate-binary-cache-key nix-cache.stevedores.org-1 secret-key public-key

# secret-key: Keep safe, use for signing
# public-key: Distribute to clients
```

## License

MIT
