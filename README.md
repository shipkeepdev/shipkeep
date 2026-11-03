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

Prerequisites: Node.js 22 (`.nvmrc`), pnpm 11 (`corepack enable` picks the pinned version), Go 1.24+, [gitleaks](https://github.com/gitleaks/gitleaks#installing) for the pre-commit hook. Docker is needed for integration tests only.

```bash
pnpm install                     # installs dependencies and the git hooks
pnpm lint                        # ESLint + TypeScript typecheck
pnpm test                        # TypeScript unit tests
go test ./agent/... ./cli/... ./lib/...
```

The local control plane stack (`pnpm dev`) arrives with task M0.5 of the plan.
