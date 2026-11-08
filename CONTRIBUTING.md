# Contributing to Shipkeep

Thank you for your interest in Shipkeep. This guide explains how to set up the project, pick a task and get a pull request merged.

Shipkeep deploys software on servers that its users own, so security rules come first. Please read the [architecture rules](#rules-that-every-change-must-respect) before writing code.

## Before you start

1. Read the [product brief](docs/PRODUCT.md) and the [architecture](docs/ARCHITECTURE.md). Then skim the [specification](docs/SPEC.md) sections that relate to your change.
2. Pick an issue.
   - [`good first issue`](https://github.com/shipkeepdev/shipkeep/labels/good%20first%20issue) issues are small, self-contained and testable locally without Docker.
   - Issues labelled `blocked` or `needs-decision` are not ready yet.
3. Comment on the issue to say you are working on it. Larger changes that are not in an issue need a short discussion first, in an issue.

## Development setup

Follow [Run Shipkeep locally](README.md#run-shipkeep-locally). To contribute, you also need:

- [gitleaks](https://github.com/gitleaks/gitleaks#installing) for the commit hook;
- Go 1.26 or newer and [golangci-lint](https://golangci-lint.run/) for changes to `agent/`, `cli/` or `lib/`.

Unit tests need neither Docker nor mail settings: `pnpm install`, then `pnpm test`.

Checks to run before opening a pull request:

```bash
pnpm lint                                    # ESLint and TypeScript
pnpm test                                    # TypeScript unit tests
go test ./agent/... ./cli/... ./lib/...      # Go tests
golangci-lint run ./agent/... ./cli/... ./lib/...
pnpm test:integration                        # needs Docker: real PostgreSQL and the Go agent
```

Generated code (protobuf, JSON Schema types, `apps/api/openapi.json`, the API client) is committed but never edited by hand. Change the source (`proto/`, `packages/config-schema`, API decorators), then run `pnpm gen`. The route and role matrix in `docs/generated/` is refreshed by `pnpm nx test api -- -u`; review its diff.

## License and sign-off

Shipkeep is licensed under [Apache-2.0](LICENSE). By contributing, you agree that your contribution is licensed under the same terms. Every commit must certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/) with a `Signed-off-by:` line: commit with `git commit -s`. A check on every pull request verifies it; `git rebase --signoff origin/main` fixes commits already made. There is no contributor license agreement.

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

## Reference

### Commands

```bash
pnpm dev:infra         # only the Docker services
pnpm dev:infra:down    # stop them, keep the data
pnpm dev:infra:reset   # stop them and delete the data volumes
pnpm lint              # ESLint + TypeScript typecheck
pnpm test              # TypeScript unit tests (vitest)
pnpm test:integration  # API/PostgreSQL + real Go daemon TLS/restart/revocation tests
pnpm exec playwright install --with-deps chromium  # one-time browser/system setup
pnpm test:browser      # production web build + HTTPS, disposable Postgres and local TLS SMTP
go test ./agent/... ./cli/... ./lib/...
pnpm gen               # regenerate code from proto/ and shipkeep.schema.json
```

### Local services

Service ports on the host: PostgreSQL 5432, VictoriaLogs 9428, VictoriaMetrics 8428, registry 5000. If one is already taken, set the matching `SHIPKEEP_DEV_*_PORT` in `.env` (see `.env.example`) and adjust both PostgreSQL URLs. Data lives in named Docker volumes. `pnpm dev` provisions a restricted API login after migrations; existing `.env` files need separate runtime and migration URLs as described in [database roles](docs/DATABASE_ROLES.md).

### Run an agent

The web UI works without an agent. To connect one to your local control plane, install Go, then:

1. In the web UI, open **Servers** and create a join token. Copy the token and the CA fingerprint.
2. Save the token in a private file outside the repository, for example `~/shipkeep-agent/join-token`, and run `chmod 600` on it.
3. Copy `deploy/agent/agent.example.yaml` to `~/shipkeep-agent/agent.yaml`. Set `control_plane.address` to `localhost:7443`, `control_plane.ca_fingerprint` to the fingerprint, `control_plane.join_token_file` to the token file, and `paths.state_dir` and `paths.run_dir` to folders you can write to.
4. Start the agent with an absolute path to the file:

   ```bash
   go run ./agent/cmd/shipkeep-agent --config /absolute/path/agent.yaml
   ```

The agent consumes the token file after saving its identity, reconnects after control plane outages and renews its certificate automatically. `--dev` without a token keeps an unenrolled agent idle.

The gateway listens on TLS port 7443 (`AGENT_GATEWAY_ADDR`). Set `AGENT_GATEWAY_SERVER_NAME` to the DNS name or IP agents use; it defaults to `localhost`.

### Production build

Production builds use `pnpm nx run-many -t build -p api web`. Start `node apps/api/dist/main.js` from the repository root with `NODE_ENV=production`, the database/KEK settings and an HTTPS `API_PUBLIC_URL` matching the public reverse proxy. The API serves the browser build from `dist/apps/web/browser`; set `WEB_DIST_DIR` for another packaged layout. Missing/invalid web builds fail startup. HTML uses fresh per-response CSP nonces and must not be cached by a proxy; hashed bundles may be cached immutably. API requests remain under `/api/v1`.

### Browser tests

Run `pnpm exec playwright install --with-deps chromium` once, then `pnpm test:browser`.

Browser acceptance always creates a fresh PostgreSQL container, even when `DATABASE_URL` is set.
Without Docker, set `SHIPKEEP_DISPOSABLE_DATABASE_URL` to a database that is safe to wipe. Chromium uses the production Angular assets against a loopback HTTPS API
and a local TLS SMTP fixture; no external email is sent. Self-signed certificate acceptance is
limited to that browser context. The suite checks public forms, signup, email verification,
login/logout, cookie/CSRF/Origin boundaries, CSP, automated WCAG rules and horizontal overflow
at widths from 320 to 1440 pixels. Security scenarios cover password reset and code reuse,
session/token invalidation, TOTP and recovery-code login, token creation/revocation, lost-response
retries, concurrent-write prevention and temporary-grant cleanup. Fault injection drops an actual
committed response and throttles its retry; real services and authorization remain enabled.
Browser time advances only for display-expiry checks. The suite records no traces, HAR files or
screenshots. Keyboard scenarios verify the skip link preserves the current form, validation
returns focus to the error summary, and narrow token tables expose their actions after resizing.

### Web design system

The web design system is documented in [apps/web/DESIGN.md](apps/web/DESIGN.md); implementation
and acceptance progress is tracked in [docs/PLAN.md](docs/PLAN.md).

## Never commit

Secrets, `.env` files, keys and certificates, database dumps, build output or personal editor settings. The pre-commit hook runs gitleaks, but please check your diff. If a secret is committed by mistake, tell a maintainer immediately: it must be rotated, not just deleted. See [CLAUDE.md](CLAUDE.md#never-commit) for the full list.

## Reporting security issues

Never open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone taking part in the project follows the [code of conduct](CODE_OF_CONDUCT.md).
