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

The API listens on http://localhost:3000/api/v1/health (OpenAPI document at `/api/v1/openapi.json`, interactive docs at `/api/v1/docs`), the web UI on http://localhost:4200 (it proxies `/api` to the API). Copy `.env.example` to `.env` to change ports or credentials.

For browser development, set `API_PUBLIC_URL=http://localhost:4200` in `.env` (also update older copies of the example). It must match the browser origin exactly; the proxy does not relax Origin or CSRF validation. Configure SMTP to exercise signup and email recovery; unconfigured mail requests fail before creating an account.

Production builds use `pnpm nx run-many -t build -p api web`. Start `node apps/api/dist/main.js` from the repository root with `NODE_ENV=production`, the database/KEK settings and an HTTPS `API_PUBLIC_URL` matching the public reverse proxy. The API serves the browser build from `dist/apps/web/browser`; set `WEB_DIST_DIR` for another packaged layout. Missing/invalid web builds fail startup. HTML uses fresh per-response CSP nonces and must not be cached by a proxy; hashed bundles may be cached immutably. API requests remain under `/api/v1`.

The agent gateway listens on TLS port 7443 (`AGENT_GATEWAY_ADDR`). Set `AGENT_GATEWAY_SERVER_NAME` to the DNS name or IP agents use; it defaults to `localhost`. The installation CA signs a separate server certificate, and agents must pin that CA before sending a join token. Enrollment and certificate renewal RPCs are available; the agent stream and REST join-token issuance are still pending M1.2c and M2.3 respectively. No installation command is exposed before those prerequisites.

Other useful commands:

```bash
pnpm dev:infra         # only the Docker services
pnpm dev:infra:down    # stop them, keep the data
pnpm dev:infra:reset   # stop them and delete the data volumes
pnpm lint              # ESLint + TypeScript typecheck
pnpm test              # TypeScript unit tests (vitest)
pnpm test:integration  # API against a real PostgreSQL (Testcontainers)
pnpm exec playwright install --with-deps chromium  # one-time browser/system setup
pnpm test:browser      # production web build + HTTPS, disposable Postgres and local TLS SMTP
go test ./agent/... ./cli/... ./lib/...
pnpm gen               # regenerate code from proto/ and shipkeep.schema.json
```

Service ports on the host: PostgreSQL 5432, VictoriaLogs 9428, VictoriaMetrics 8428, registry 5000. If one is already taken, set the matching `SHIPKEEP_DEV_*_PORT` in `.env` (see `.env.example`) and adjust both PostgreSQL URLs. Data lives in named Docker volumes. `pnpm dev` provisions a restricted API login after migrations; existing `.env` files need separate runtime and migration URLs as described in [database roles](docs/DATABASE_ROLES.md).

Browser acceptance requires Docker and always creates a fresh PostgreSQL container, even when
`DATABASE_URL` is set. Chromium uses the production Angular assets against a loopback HTTPS API
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
The web design system is documented in [apps/web/DESIGN.md](apps/web/DESIGN.md); implementation
and acceptance progress is tracked in [docs/PLAN.md](docs/PLAN.md).
