# Contributing to Shipkeep

Thank you for your interest in Shipkeep. This guide explains how to set up the project, pick a task and get a pull request merged.

Shipkeep deploys software on servers that its users own, so security rules come first. Please read the [architecture rules](#rules-that-every-change-must-respect) before writing code.

## Before you start

1. Read the [product brief](docs/PRODUCT.md) and the [architecture](docs/ARCHITECTURE.md). Then skim the [specification](docs/SPEC.md) sections that relate to your change.
2. Pick an issue.
   - [`good first issue`](https://github.com/samuelmbabhazi/shipkeep/labels/good%20first%20issue) issues are small, self-contained and testable locally without Docker.
   - Issues labelled `blocked` or `needs-decision` are not ready yet.
3. Comment on the issue to say you are working on it. Larger changes that are not in an issue need a short discussion first, in an issue.

## Development setup

You need:

- Node.js 22 (`.nvmrc`) and pnpm 11 (`corepack enable` picks the pinned version);
- Go 1.26 or newer;
- Docker with Compose v2;
- [gitleaks](https://github.com/gitleaks/gitleaks#installing) for the pre-commit hook.

```bash
pnpm install   # dependencies and git hooks
pnpm dev       # local services in Docker, then the API and web UI with hot reload
```

The [README](README.md#development) lists every command, port and environment variable.

Checks to run before opening a pull request:

```bash
pnpm lint                                    # ESLint and TypeScript
pnpm test                                    # TypeScript unit tests
go test ./agent/... ./cli/... ./lib/...      # Go tests
golangci-lint run ./agent/... ./cli/... ./lib/...
pnpm test:integration                        # needs Docker: real PostgreSQL and the Go agent
```

Generated code (protobuf, JSON Schema types, `apps/api/openapi.json`, the API client) is committed but never edited by hand. Change the source (`proto/`, `packages/config-schema`, API decorators), then run `pnpm gen`. The route and role matrix in `docs/generated/` is refreshed by `pnpm nx test api -- -u`; review its diff.

## Workflow

- **Branches:** one branch per issue, never on `main`: `feat/<task-id>-short-name`, `fix/...` or `docs/...`.
- **Commits:** follow [Conventional Commits](https://www.conventionalcommits.org/), for example `feat(agent): validate volume names`. A commit hook enforces the format; the first line is at most 100 characters.
- **Pull requests:** fill in the template: what changed, why, how it was tested, security considerations. Link the issue (`Closes #123`). Aim for fewer than 500 changed lines, excluding generated code.
- **Security review:** changes that touch the agent, authentication, secrets, builds, RBAC or the agent action list need the `security-review` label and a maintainer's review.
- **Merging:** pull requests are squash-merged once checks pass and a maintainer approves.

## Rules that every change must respect

The full list is in [CLAUDE.md](CLAUDE.md#architecture-rules-never-break-these). In short:

1. **No shell commands built from strings.** The agent talks to Docker and Caddy through their APIs.
2. **The agent action list is closed.** New actions need an ADR or SPEC change, input validation and malicious-input tests.
3. **The control plane never holds SSH keys,** and the agent never runs commands on the host.
4. **Domain code is pure:** no framework, database, HTTP or file system imports in `packages/domain` or a module's `domain/` folder.
5. **Every state change is audited.** `apps/api/src/audit-coverage.spec.ts` requires each new mutating route to declare its audit events.
6. **Destructive actions need a confirmation token** (SPEC 3.6).
7. **Secrets never reach logs, URLs, error messages or `shipkeep.yml`.** Use the `Secret` wrappers.
8. **Tenant data stays in its organization:** repository filters and PostgreSQL row-level security are both required.

Dependencies must use one of these licenses: MIT, Apache-2.0, BSD-2/3, ISC or MPL-2.0. Anything else needs an approved exception (ADR 0014).

## Tests

- Write the failing test first for domain logic. Unit tests live next to the code (`*.spec.ts`, `*_test.go`).
- Integration tests use real PostgreSQL and Docker (Testcontainers), never mocks of them.
- Anything that handles user or agent input gets malicious-input tests: path traversal, injection characters, oversized values.

## Never commit

Secrets, `.env` files, keys and certificates, database dumps, build output or personal editor settings. The pre-commit hook runs gitleaks, but please check your diff. If a secret is committed by mistake, tell a maintainer immediately: it must be rotated, not just deleted. See [CLAUDE.md](CLAUDE.md#never-commit) for the full list.

## Reporting security issues

Never open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone taking part in the project follows the [code of conduct](CODE_OF_CONDUCT.md).
