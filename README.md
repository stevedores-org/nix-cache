> **New here?** Start with [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) — a first-hour guide for human developers (prerequisites, build, project structure, IDE setup, CI/CD, and making your first PR).

# Local CI Validation (MANDATORY)

All contributors must use the provided Makefile and actionlint to validate their changes locally before pushing or opening a PR.

## How to Validate Locally

1. **Run all checks:**
   ```bash
   make test
   ```
2. **Rust workspace (mirrors Workspace Rust Checks CI):**
   ```bash
   make lci
   # Alias:
   make local-ci
   # If stevedores-org/local-ci CLI is installed, `make local-ci`
   # uses `.local-ci.toml`; otherwise it falls back to tools/lci.
   # Machine-readable output:
   make lci-json
   ```
3. **Just check YAML workflows:**
   ```bash
   make test-yaml
   ```

If you do not have actionlint installed:
```bash
brew install actionlint
```

For more details, see [docs/LOCAL_CI_VALIDATION.md](docs/LOCAL_CI_VALIDATION.md).

This workflow ensures that all documentation and YAML workflows are robust and error-free before merging to develop.

## Agent Pre-Commit

All agents must run the repo pre-commit checks before committing changes.

# **Grow Without Limits — Lornuai, Inc.**

## ---

[![Bun](https://img.shields.io/badge/Bun-1.3+-black?logo=bun&logoColor=white)](https://bun.sh)
[![Rust](https://img.shields.io/badge/Rust-1.80+-CE412B?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![Crossplane](https://img.shields.io/badge/Crossplane-Control%20Plane-0470FF?logo=crossplane&logoColor=white)](https://crossplane.io)
[![Kubernetes](https://img.shields.io/badge/Kubernetes-EKS%20%2F%20GKE-326CE5?logo=kubernetes&logoColor=white)](https://kubernetes.io)
[![Kustomize](https://img.shields.io/badge/Kustomize-v5+-1ABC9C?logo=kubernetes&logoColor=white)](https://kustomize.io)

**Mission**

**Deliver a 50–70% reduction in engineering time and operational overhead** through a hardened, metadata-driven **Minimum Viable Infrastructure (MVI)**. Grow Without Limits consolidates delivery onto **one EKS/GKE cluster** with **Kustomize-based multi-namespace isolation** across `lornu-ai-dev`, `lornu-ai-staging`, and `lornu-ai-prod` namespaces.

## **Autonomous Workflow Protocol**

When tasked with project maintenance or objective progression, follow this Algorithmic Logic loop:

1. **Poll & Prioritize**:
   - Use available tools to fetch the latest open GitHub Pull Requests and Issues.
   - Categorize by impact and urgency.

2. **Analyze & Engage**:
   - Review each item thoroughly.
   - Post relevant comments, code reviews, or technical feedback directly to the threads.

3. **Document**:
   - Update the primary GitHub Issue(s) with a concise summary of progress made and the current status of the objective.
   - This ensures the "Source of Truth" is always current.

4. **Iterate**:
   - Identify the next highest-priority action item to maintain momentum.
   - Propose or initiate the next logical file change or command.

5. **Exception Handling**:
   - If a task is blocked, requires credentials you lack, or needs human architectural input, **STOP** immediately.
   - Clearly define the blocker and ask the user for guidance.

## **Shared Agent State**

Lornu AI utilizes a **Shared State Mechanism** to synchronize context across multiple IDE agents (Windsurf, Cursor, VSCode):

- **File**: `.lornu/STATE.json` (git-ignored)
- **Purpose**: Tracks active agents, tasks, branch status, and compliance.
- **Protocol**: Managed by `lornu-mcp-hub`, exposed via `mcp://lornu-ai/state`.
- **Security**: Local-only, file permissions 600.

## **CI/CD Quality Gates (Grow Without Limits Unified)**

The repository implements a 3-tier validation engine for all infrastructure changes:

1. **Level 1: Syntactic Build Test**: Validates that all Kustomize overlays can be built successfully (`kustomize build`).
2. **Level 2: Schema Validation**: Uses `kubeconform` to validate Kubernetes resources against official schemas.
3. **Level 3: Security & Policy Guardrails**: Uses `Checkov` to scan for security misconfigurations and policy violations.
4. **Secret Scanning**: Uses `Gitleaks` to prevent sensitive data from being committed.
5. **Label Compliance**: Ensures all resources have mandatory `lornu.ai/environment`, `lornu.ai/managed-by`, and `lornu.ai/asset-id` labels.
6. **Gemini Code Review**: Automated AI code review for all Pull Requests (Issue #695).
7. **PR Merge Policy**: NO pull requests may be merged if there are failing CI checks or unresolved merge conflicts.
8. **Unit Test Coverage**: Coverage is enforced with a phased rollout via `.github/workflows/rust-coverage.yml` (75% threshold: warn on PRs/non-main pushes, block on `main` push).

**Declarative GitOps Policy**: All infrastructure changes must follow the declarative GitOps workflow. Imperative commands are prohibited. See [docs/DECLARATIVE_GITOPS_POLICY.md](docs/DECLARATIVE_GITOPS_POLICY.md).

## **Zero-Trust OIDC Authentication**

Lornu AI implements **universal OIDC federation** for sovereign, zero-secret authentication across all environments:

### **AWS Hub (EKS) - IRSA**
- **IAM OIDC Provider**: GitHub Actions + EKS service accounts
- **Roles**: `lornu-ai-github-actions-role`, `lornu-ai-flux-controller-role`
- **Annotation**: `eks.amazonaws.com/role-arn: arn:aws:iam::${AWS_ACCOUNT_ID}:role/...`

### **GCP Spoke (GKE) - Workload Identity**
- **Workload Identity Pool**: `github-pool` with GitHub + EKS providers
- **Service Account**: `lornu-ai-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com`
- **Annotation**: `iam.gke.io/gcp-service-account: ...`

### **GitOps Flow**
1. **GitHub Actions** → OIDC → IAM Roles → Temporary Credentials
2. **EKS/GKE Pods** → IRSA/Workload Identity → Cloud Resources
3. **Zero Static Secrets** - All authentication is federated

These gates are enforced on every Pull Request to `develop` and `staging`.

## **Global Low-Cost Data Fabric (GLCDF)**

The **GLCDF** is a unified, globally distributed persistence layer designed for autonomous agents, optimized for extreme cost-efficiency and sovereign data control (Issue #541).

- **Storage Engine**: Azure Cosmos DB (Serverless/Provisioned Multi-region) + Azure Blob Storage.
- **Architecture**: Decoupled compute/storage with zero-copy ingest and local-first caching.
- **Cost Optimization**: 50-70% reduction in state storage costs compared to traditional NoSQL.
- **Latency Sovereignty**: Global distribution ensuring <100ms state retrieval for agents worldwide.
- **Governance**: Integrated with `warden` for PII/Secret scrubbing and `zen` for governance.
- **Client Library**: `packages/glcdf-client/` - Python async client with lazy loading and local caching.

### Quick Start (glcdf-client)
Client libraries available in Rust and TypeScript for agent state management.

- **Build Once, Promote Often**: All container images are built and mirrored to all clouds by Dockworker.ai, ensuring a single cryptographic digest. Production is promoted by SHA.
- **Target Branch**: All development PRs must target the `develop` branch.
- `.github/workflows/`: Consolidated intelligent orchestrators (Issue #440)
- `dockworker.toml`: Sovereign Build Manifest (Issue #439)
- `crossplane/hub/deploy/overlays/gcp/`: GCP hub control-plane + infra (PRIMARY Operational Hub)
- `crossplane/hub/deploy/overlays/azure/`: Azure hub control-plane + infra (In Provisioning)
- **Production**: Updates to `main` are for production stabilization and promotion.

* **Control Plane (Private Hub)**: `private-lornu-ai` (Zero-Secret, SOPS-Encrypted).
* **Workload Plane (Public Spoke)**: `lornu-ai` (Application Manifests, Open-Source compatible).
* **Sync Mechanism**: Flux CD bootstrapped to `private-lornu-ai`.
* **Single EKS/GKE cluster** with `lornu-ai-dev`, `lornu-ai-staging`, and `lornu-ai-prod` namespaces.
* **Kustomize overlays** per environment (Spoke-managed).
* **Crossplane** as infrastructure control plane.
* **Modern runtimes**: Rust (Backend/Core), Bun (Frontend).
* **Tooling**: Rust (MANDATORY - Rust-or-Bust policy for all backend components), Bun (Frontend), Infrastructure Cleanup (`scripts/aws-cleanup.sh`).
* **Performance Sovereignty**: Bolt ⚡ persona ensures sub-100ms latency and maximum cost-efficiency.
* **Unified Organization**: High-value AI/Agentic repositories consolidated from legacy orgs (see [Repository Migration Audit](docs/STEVEI101_REPO_MIGRATION_AUDIT.md)).
* **Global Low-Cost Data Fabric (GLCDF)**: Multi-region, Azure-optimized persistence layer for sovereign agent state and long-term memory (Issue #541).

## **Key Operational Agents**

Lornu AI includes several autonomous agents for operational excellence:

- **SRE Auto-Remediation Agent** (`ai-agents/sre-agent-rs/`): Rust-based Kubernetes pod failure detection with AI-driven remediation using GPT-4o via Rig framework
- **Drift Enforcer Agent** (`ai-agents/drift-enforcer/`): Multi-cloud resource sprawl detection and automated decommissioning
- **Workflow Sentinel** (`ai-agents/workflow-sentinel-rs/`): High-performance GitHub Actions linter implemented in Rust
- **PR Review Agent** (`ai-agents/ai-agent-pr-review/`): Automated code review with Gemini integration
- **Cloudflare DNS Agent** (`ai-agents/cloudflare-dns-agent/`): Multi-cloud DNS synchronization across AWS Route53, GCP Cloud DNS, and Azure DNS

For complete agent documentation, see [AGENTS.md](AGENTS.md).

## **Directory Structure**

```plaintext
crossplane/hub/deploy/          # Unified hub infrastructure (Issue #472)
  ├── base/                     # Shared infrastructure APIs
  └── overlays/{aws,azure,gcp}/ # Cloud-specific + app-agents
crossplane/spoke/apps/          # Spoke workloads (23 apps + 5 hub agents)
apps/                           # Deployable applications (23 total)
  ├── automation-hub/           # Cloudflare Workers (OIDC hub + CI automation)
  ├── lornu-ai/                 # Lornu AI application parent
  │   ├── frontend/             # React frontend (Bun)
  │   └── deploy/               # Deployment manifests (Flux/Kustomize)
  ├── dockworker-ai/            # Dockworker AI application parent
  │   ├── frontend/             # React frontend (Bun)
  │   ├── backend/              # Rust backend
  │   └── worker/               # Rust worker
  ├── api/                      # Rust backend
  ├── cloudflare-dns-agent/     # DNS Sync Agent (Rust)
  ├── cloudflare-edge-discovery/ # Edge Discovery Worker (TypeScript)
  └── [17 more applications]
ai-agents/                      # Autonomous Agents (Rust)
  ├── aiops-agent/              # AIOps Auto-Remediation
  ├── ai-agent-cleaner/         # Security scanner
  ├── ai-agent-pr-review/       # CI gatekeeper
  ├── sre-agent/                # SRE Auto-Remediation
  └── agent-registry/           # FastA2A Agent Registry Service
packages/                       # Reusable libraries ONLY
  ├── glcdf-client/             # Global Low-Cost Data Fabric client (Rust/TS)
  ├── lornu-mcp-hub/            # MCP tools hub
  └── ai-agent-cleaner/         # Cleaner library
templates/                      # Satellite repository templates (7-File Rule, CI/CD)
terraform/                      # Legacy infrastructure (Terraform Cloud)
```

### **Lornu AI Multi-Cloud Mesh (Active Satellites)**
| Satellite | Role | Primary Cloud | Status |
| :--- | :--- | :--- | :--- |
| **gitlab-container-builds** | Sovereign Agent Builder & CI Templates | GitLab | ✅ Active |
| **automation-hub** | Centralized Cloudflare Workers | Cloudflare | ✅ Active |
| **lornu-aks-hub** | Azure Hub Control Plane | Azure | ✅ Active |

| Satellite | Cloud | Region | Endpoint | Status | Logistcs |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **lornu-aks-hub** | Azure | eastus2 | `api.lornu.ai` | ✅ Active (Hub) | Flux/Crossplane |
| **<GCP_GKE_CLUSTER_NAME>** | GCP | us-central1 | `<GCP_GKE_LB_IP>` | ✅ Active (GCP) | Flux/GKE |
| **dockworker-ai** | AWS | us-east-2 | `dockworker.lornu.ai` | ✅ Active | Container packaging platform |
| **financial-agent-spoke** | GCP | us-central1 | `email.lornu.ai` | ⚠️ Migrating | App+SQL Overlay |
| **ai-agent-core** | AWS | us-east-2 | `core.lornu.ai` | ✅ Active | Flux/Crossplane |
| **lornu-crawler** | GCP | us-central1 | `crawler.lornu.ai` | ✅ Active | Playwright/Flux |
| **YouTube** | N/A | N/A | `youtube.com/@lornu-ai` | ✅ Active | Community Link |

## **Satellite Repositories**

Lornu AI uses a **hub-and-spoke architecture** where application source code lives in separate **satellite repositories**, while this hub repository manages deployment manifests and infrastructure:

### **Active Satellite Repositories**

| Repository | Purpose | Registry | Status |
|------------|---------|----------|--------|
| logistics-supervisor-api | Container packaging platform | AWS ECR | ✅ Active |
| financial-agent-spoke | Intelligent email response | AWS ECR | ✅ Active |
| [ai-agents-core](https://github.com/lornu-ai/ai-agents-core) | Centralized agent framework | AWS ECR | ✅ Active |
| [lornu-crawler](https://github.com/lornu-ai/lornu-crawler) | Site crawler & screenshotter | GCP Artifact Registry | ✅ Active |
| [cloudflare-dns-agent](apps/cloudflare-dns-agent/README.md) | Multi-Cloud DNS Sync Agent | ECR/GAR/ACR | ✅ Active |
| [cloudflare-edge-discovery](apps/cloudflare-edge-discovery/README.md) | Edge Discovery Worker (Hyperdrive) | Cloudflare Workers | ✅ Active |
| [lornu.ai](https://github.com/lornu-ai/lornu.ai) | Hub repository (Crossplane/Flux) | AWS ECR | ✅ Active |
| [agentnav](https://github.com/lornu-ai/agentnav) | Agentic Navigation module | N/A | ✅ Active |
| [product-mindset](https://github.com/lornu-ai/product-mindset) | Product Mindset analytics | N/A | ✅ Active |
| [cursor-agent-rules](https://github.com/lornu-ai/cursor-agent-rules) | Automated AI-Code Review | N/A | ✅ Active |
| [autonomous-sre-agent](https://github.com/lornu-ai/autonomous-sre-agent) | Sovereign SRE drift detection + auto-remediation | N/A | ✅ Active |
| [gcp-conversation-service](https://github.com/lornu-ai/gcp-conversation-service) | Gemini Integration hub | GCP Cloud Run | ✅ Active |
| [email-triage](https://github.com/lornu-ai/email-triage) | Automated email triage | N/A | ✅ Active |
| [antigravity-ide-tracker](https://github.com/lornu-ai/antigravity-ide-tracker) | IDE/Dev workflow tracking | N/A | ✅ Active |
| [not-sure](https://github.com/lornu-ai/not-sure) | Migration of stevei101/not-sure | N/A | ✅ Active |

# nix-cache

A **plain Nix binary cache** (not [Attic](https://github.com/zhaofengli/attic)) backed by Cloudflare R2. It implements the standard Nix binary cache protocol — `nix-cache-info`, `.narinfo`, and `.nar` files served over HTTPS.

**This is NOT an Attic server.** Use `nix copy --to` for uploads, not `attic push`. The `attic-client` package is not needed.

## Architecture

```mermaid
flowchart LR
    subgraph Clients
        Dev[Developer Machine]
        CI[GitHub Actions CI]
    end

    subgraph Cloudflare
        W[Worker<br>nix-cache.stevedores.org]
        R2[(R2 Bucket<br>nix-cache)]
        KV[(KV<br>METRICS)]
    end

    Dev -- "GET .narinfo/.nar" --> W
    CI -- "GET .narinfo/.nar" --> W
    CI -- "PUT .narinfo/.nar<br>(Bearer auth)" --> W
    W -- "read/write" --> R2
    W -- "incr counters" --> KV
```

**Data flow:**
- **GET** (public): Nix client requests `.narinfo`/`.nar` → Worker fetches from R2 → returns to client
- **PUT** (authenticated): CI signs store paths → `nix copy --to` uploads to Worker → Worker stores in R2
- **Metrics**: Every request increments KV counters → `/metrics` endpoint returns JSON

## Quick Start for New Repos

Add this to your `flake.nix`:
```nix
{
  nixConfig = {
    extra-substituters = [ "https://nix-cache.stevedores.org" ];
    extra-trusted-public-keys = [ "stevedores-cache-1:bXLxkipycRWproIJnk8pPWNFdgVfeV+I2mJXCoW4/ag=" ];
  };

  # ... rest of your flake
}
```

That's it — Nix will now pull cached builds from `nix-cache.stevedores.org`.

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/` | GET | No | Cache info (`nix-cache-info` format) |
| `/nix-cache-info` | GET | No | Cache info |
| `/health` | GET | No | Health check (JSON) |
| `/metrics` | GET | Bearer | JSON counters (hits, misses, uploads, auth failures) |
| `/<hash>.narinfo` | GET | No | Package metadata |
| `/nar/<hash>.nar` | GET | No | Package archive |
| `/*` | PUT | Bearer | Upload to R2 |

## Monitoring

### Metrics Endpoint

```bash
curl -H "Authorization: Bearer $CACHE_AUTH_TOKEN" https://nix-cache.stevedores.org/metrics
```

Returns:
```json
{
  "get_hit": 142,
  "get_miss": 23,
  "put_ok": 87,
  "auth_fail": 2,
  "get_total": 165
}
```

### Cloudflare Dashboard

- **Worker analytics**: Requests, errors, latency — [CF Dashboard > Workers > nix-cache](https://dash.cloudflare.com/f1be33af27cf878e2e81cb29a0d886f7/workers/services/view/nix-cache/production)
- **R2 storage**: Object count, storage usage — [CF Dashboard > R2 > nix-cache](https://dash.cloudflare.com/f1be33af27cf878e2e81cb29a0d886f7/r2/default/buckets/nix-cache)
- **Observability logs**: Enabled in `wrangler.toml` — visible in CF dashboard under Workers > Logs

## Development Commands

```bash
bun install          # Install deps
bun test             # Run integration tests
bunx tsc --noEmit    # Type check
bunx wrangler dev    # Run locally
local-ci             # Run all CI checks locally (typecheck + test)
```

Deployment is automatic via Cloudflare Workers Builds — pushes to `main` trigger deploys.

## Cloudflare Resources

| Resource | Type | Purpose |
|----------|------|---------|
| `nix-cache` | Worker | Request routing, auth, metrics |
| `nix-cache` | R2 bucket | `.narinfo` + `.nar` storage |
| `METRICS` | KV namespace | Counter storage |
| `CACHE_AUTH_TOKEN` | Worker secret | PUT authentication |

## Key Rotation

```bash
# Generate new keypair
nix-store --generate-binary-cache-key stevedores-cache-2 /path/to/secret /path/to/public

# Update everywhere:
# 1. GitHub org secrets: NIX_SIGNING_SECRET_KEY, NIX_SIGNING_PUBLIC_KEY
# 2. This README (public key references)
# 3. wrangler.toml NIX_PUBLIC_KEY var
# 4. All consuming flake.nix files (extra-trusted-public-keys)
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `nix build` ignores cache, builds from source | Missing `extra-trusted-public-keys` in `flake.nix` | Add the public key (see Quick Start) |
| `warning: ignoring substitute` | Public key mismatch or missing | Verify key matches `stevedores-cache-1:bXLx...` |
| 404 on `.narinfo` | Store path not cached yet | Push it from CI or manually |
| 401 on PUT | Missing or wrong `Authorization` header | Use `Bearer <CACHE_AUTH_TOKEN>` |
| 403 on PUT | Invalid token | Check `CACHE_AUTH_TOKEN` matches CF Worker secret |
| 500 on PUT | `CACHE_AUTH_TOKEN` not set on Worker | Set it via `wrangler versions secret put` |

## Disaster Recovery

If R2 data is lost, the cache can be repopulated by re-running CI builds on all repos. The cache is a **performance optimization**, not a source of truth — all packages can be rebuilt from source.

```bash
# Trigger rebuilds across all repos
for repo in oxidizedMLX aivcs oxidizedRAG local-ci; do
  gh workflow run ci.yml --repo "stevedores-org/$repo"
done
```

## CI Integration

### Reusable GitHub Actions

This repo provides composite actions. Add to your workflow:

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

      - uses: stevedores-org/nix-cache/.github/actions/push@develop
        if: github.event_name == 'push'
        with:
          paths: .#default
```

### Action Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `push` | No | Enable cache uploads (default: `false`) |
| `cache-auth-token` | If push | Bearer token for PUT auth |
| `signing-secret-key` | If push | Ed25519 secret key for signing |

### Manual CI Setup

If not using the composite actions:
```bash
echo "$NIX_SIGNING_SECRET_KEY" > /tmp/nix-sign-key
nix store sign --key-file /tmp/nix-sign-key $(nix build .#default --no-link --print-out-paths)
nix copy --to "https://nix-cache.stevedores.org" $(nix build .#default --no-link --print-out-paths)
```

## Secrets Reference

All secrets are stored at **org level** (`stevedores-org` GitHub org settings) and as Cloudflare Worker secrets.

| Secret | Where | Purpose |
|--------|-------|---------|
| `CACHE_AUTH_TOKEN` | GH org + CF Worker | Bearer token for PUT uploads |
| `NIX_SIGNING_SECRET_KEY` | GH org | Ed25519 secret key for signing store paths |
| `NIX_SIGNING_PUBLIC_KEY` | GH org | Public key for reference in CI |

**Public key** (safe to share): `stevedores-cache-1:bXLxkipycRWproIJnk8pPWNFdgVfeV+I2mJXCoW4/ag=`

## Pushing to the Cache

Upload pre-built packages using `nix copy` (the standard Nix protocol):

```bash
# From a developer machine
nix store sign --key-file /path/to/secret-key /nix/store/abc123-mypackage
nix copy --to "https://nix-cache.stevedores.org" /nix/store/abc123-mypackage
```

> **Do NOT use `attic push`** — this is a plain binary cache, not an Attic server.

---

### **Setting Up New Satellites**

All container builds and multi-cloud pushes are now handled by Dockworker.ai, ensuring a single cryptographic digest across AWS, GCP, and Azure. See `dockworker.toml` for configuration and `.github/workflows/dockworker-sync.yml` for the workflow.

**Org policy — never `Dockerfile`:** lornu-ai and stevedores-org build images with **Nix OCI** (`flake.nix`) + **dockworker.ai**, not hand-written Dockerfiles. Do not add or restore `Dockerfile` / `docker build`; see the 6-file instruction set (`.cursorrules`, `AGENTS.md`, etc.) for agents.

### **Automation & Infrastructure Satellites**

**Cloudflare Workers** are managed in the **automation-hub** repository:
- **Repository**: [lornu-ai/automation-hub](https://github.com/lornu-ai/automation-hub)
- **Workers**: `automation-hub` (CI automation), `lornu-edge-discovery` (agent discovery via Hyperdrive)
- **Private RAG (Issue #565)**: R2 bucket + Vectorize for agent knowledge grounding
  - Endpoints: `/api/rag/search`, `/api/vectorize/trigger`, `/api/vectorize/status`
  - R2 Bucket: `lornu-private-rag-prod`
  - Vectorize Index: `lornu-private-knowledge` (768 dims, bge-base-en-v1.5)
- **Deployment**: Uses Wrangler CLI (`wrangler deploy`)
- **Related Issues**: #589 (Edge Discovery), #542 (CI Automation), #565 (Private RAG)

**GitLab CI/CD** configurations are managed in the **gitlab-container-builds** repository:
- **Repository**: [lornu-ai/gitlab-container-builds](https://github.com/lornu-ai/gitlab-container-builds)
- **Purpose**: GitLab CI/CD pipelines for container builds and multi-cloud mirroring
- **Related**: GitLab pull mirroring setup (see `docs/GITLAB_MIRROR_SETUP.md`)

## **Development Standards**

### **The 7-File Rule (Documentation as Infrastructure)**

Treating documentation as infrastructure ensures all AI assistants (Cursor, Windsurf, Copilot) operate with synchronized context, preventing schema drift and maintaining the **Sovereign Knowledge Fabric.**

**Mandatory Context Files:**
1. **`.cursorrules`**: Local IDE rules.
2. **`AGENTS.md`**: A2A Protocol and Agent capabilities.
3. **`CLAUDE.md`**: Build/test commands and project context.
4. **`README.md`**: High-level project map.
5. **`ARCH_PRESERVE.md`**: Architectural preservation rules.
6. **`.github/copilot-instructions.md`**: GitHub Copilot context.
7. **`.github/system-instruction.md`**: Global "Sovereign Intelligence" standards.

**When to update:**
- New features added to `apps/` or `app-agents/`
- Changes to deployment patterns, build commands, or infrastructure
- New standards, conventions, or governance policies

### **Agent Workflow (Autonomous Operation Loop)**

When working autonomously, agents follow this algorithmic loop:

1. **Poll & Prioritize**: Fetch the latest open GitHub Pull Requests and Issues.
2. **Analyze & Engage**: Review each item and post relevant comments or actionable feedback.
3. **Document**: Update the primary GitHub Issue(s) with a concise summary of progress made and current status.
4. **Iterate**: Identify the next highest-priority action item to maintain momentum.
5. **Exception Handling**: If a task is blocked or requires human input, stop and ask for guidance immediately.

### **Pull Request Requirements**

* **Labeling**: Apply a label for the **worker/agent** (e.g., `codex`, `claude`, `antigravity`, `vs-code`, `jules`, `gemini-cli`).
  - Create label if needed: `gh label create <agent-name>`
  - Apply to PR: `gh pr edit <pr-number> --add-label <agent-name>`
* **Base Branch**: All PRs must target the `develop` branch.
* **Documentation Sync**: Every PR must include updates to the **7-File Rule** if architectural changes are made.
* **Terraform Hygiene**: Run `terraform fmt` and `terraform validate` before pushing changes.

## **Infrastructure & Deployment**

### **GitOps Architecture (Flux + ArgoCD + Crossplane + ESO)**

Grow Without Limits uses a **declarative GitOps model** with clear separation of concerns:

- **Flux CD**: Primary GitOps engine for cluster bootstrapping and application delivery.
- **ArgoCD**: Visual orchestrator for multi-cluster workload management.
- **Crossplane**: Control plane for managing cloud resources (AWS, GCP, Azure) as Kubernetes objects.
- **External Secrets Operator (ESO)**: Secure secret injection from AWS Secrets Manager/Azure Key Vault.

For detailed policy, see [docs/DECLARATIVE_GITOPS_POLICY.md](docs/DECLARATIVE_GITOPS_POLICY.md).

## **Official Contact Information**

- **Contact**: `contact@lornu.ai` - Official email for all external communications
- **Policy**: Only publish `contact@lornu.ai` in documentation and UI. Never publish personal or alternative email addresses.
