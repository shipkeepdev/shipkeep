# Shipkeep

Your own cloud on your own servers, without leaving the root key in a web panel.

Shipkeep is a self-hosted platform to deploy applications, databases and services on servers you own: git push to deploy, automatic HTTPS, managed databases with backups, preview environments, logs, metrics and alerts, across one or many servers.

> Status: private, pre-v0.1. The code will be published under Apache-2.0 at v1.0.

## Documentation

- [Product brief](docs/PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Technical specification](docs/SPEC.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Implementation plan](docs/PLAN.md)
- [Architecture decision records](docs/adr/)
- [Contributor guide for Claude Code](CLAUDE.md)
- [GitHub setup](docs/GITHUB_SETUP.md)
- [Kickoff prompts for Claude Code](docs/CLAUDE_CODE_KICKOFF.md)

## Development

Prerequisites: Node.js 22 (`.nvmrc`), pnpm 11 (`corepack enable` picks the pinned version), Go 1.26+, Docker with Compose v2, and [gitleaks](https://github.com/gitleaks/gitleaks#installing) for the pre-commit hook.

Two commands start everything:

```bash
pnpm install   # dependencies and git hooks
pnpm dev       # PostgreSQL, VictoriaLogs, VictoriaMetrics and a registry in Docker, then the API and the web UI with hot reload
```

The API listens on http://localhost:3000/api/v1/health, the web UI on http://localhost:4200 (it proxies `/api` to the API). Copy `.env.example` to `.env` to change ports or credentials.

Other useful commands:

```bash
pnpm dev:infra         # only the Docker services
pnpm dev:infra:down    # stop them, keep the data
pnpm dev:infra:reset   # stop them and delete the data volumes
pnpm lint              # ESLint + TypeScript typecheck
pnpm test              # TypeScript unit tests
go test ./agent/... ./cli/... ./lib/...
pnpm gen               # regenerate code from proto/ and shipkeep.schema.json
```

Service ports on the host: PostgreSQL 5432, VictoriaLogs 9428, VictoriaMetrics 8428, registry 5000. If one is already taken, set the matching `SHIPKEEP_DEV_*_PORT` in `.env` (see `.env.example`) and adjust `DATABASE_URL`. Data lives in named Docker volumes.
