# CLAUDE.md

Guidance for Claude Code working in the Shipkeep repository. Read this file fully before any task.

## What Shipkeep is

Shipkeep is a self-hosted PaaS: a Coolify-class platform that deploys apps, databases and services to servers the user owns. It differs from Coolify on four points that every change must protect:

1. **Secure by design.** No control-plane-held SSH root key. No shell command is ever built from strings. Agents open an outbound mTLS connection and execute a closed list of typed actions.
2. **Config in the repo.** Each app is described by a versioned `shipkeep.yml`. The UI writes to that file (commit or PR) instead of hiding state.
3. **Real multi-node.** Placement, health-based failover, private WireGuard network and replicated routing, without Kubernetes.
4. **Safe upgrades and destructive actions.** Snapshots before upgrades, resumable operations, explicit confirmation for anything destructive.

Read in this order before coding: `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/SPEC.md`, `docs/THREAT_MODEL.md`, `docs/PLAN.md`, then the ADRs in `docs/adr/`.

## Language

Everything is in English: code, comments, commit messages, PR descriptions, issues, docs, UI strings, logs, error messages.

## Repository layout

```text
apps/
  api/              Control plane API, NestJS 12 (TypeScript)
                      src/platform/   cross-cutting: config (zod), logging (pino), http (problem details, validation), prisma, health, openapi, events (DomainEventBus), crypto (KEK, envelope encryption)
                      src/modules/    bounded contexts, one folder each (see conventions below)
                      prisma/         schema.prisma and migrations; prisma.config.ts for the CLI
                      openapi.json    generated contract of the REST API (pnpm gen:openapi)
  web/              Web UI, Angular (TypeScript)
agent/              Node agent, Go module github.com/samuelmbabhazi/shipkeep/agent (single static binary)
cli/                CLI, Go module github.com/samuelmbabhazi/shipkeep/cli (single static binary)
lib/                Shared Go module github.com/samuelmbabhazi/shipkeep/lib:
                      lib/gen      generated protobuf and gRPC code
                      lib/config   shipkeep.yml types (generated), embedded schema copy (generated) and validator, shared by agent, cli and fuzz tests
                      lib/secret   Secret wrappers that redact in fmt, slog, JSON and YAML (rule 8)
                      lib/agentproto helpers over the generated agent protocol (action kinds)
proto/              gRPC + protobuf contract between control plane and agent (single source of truth)
packages/
  domain/           Pure domain model and rules (TypeScript, no framework imports)
  config-schema/    JSON Schema for shipkeep.yml (source of truth), generated TS types, TS validator, golden fixtures
  api-client/       Generated TypeScript client for the public REST API (used by web)
  proto-ts/         Generated TypeScript code from proto/ (used by api)
templates/          Service catalog (Compose files + metadata)
deploy/             Install script, control plane compose file, systemd units
docs/               Product, architecture, spec, threat model, plan, ADRs
e2e/                End-to-end tests against real VMs
.github/            Workflows, templates, CODEOWNERS
```

## Tooling and commands

- Node.js 22 LTS (`.nvmrc`), pnpm 11 (pinned in `package.json` `packageManager`, use Corepack or `pnpm@11`), Nx 24 for the TypeScript workspace.
- Go 1.26+ for `agent/`, `cli/` and `lib/` (three modules in one Go workspace, `go.work` at repo root, no root module).
- The repository lives under the `samuelmbabhazi` account; the `shipkeephq` organization does not exist yet. If the repository is transferred, update the Go module paths and `docs/GITHUB_SETUP.md` in one PR.
- `buf` (from the `@bufbuild/buf` npm package, so `pnpm exec buf` always matches CI) for protobuf lint, breaking-change checks and code generation. Plugins run remotely on buf.build with versions pinned in `buf.gen.yaml`.
- Docker with BuildKit for local integration tests.

| Task                                 | Command                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Install                              | `pnpm install`                                                                                               |
| Generate code from proto and schema  | `pnpm gen` (proto, shipkeep.yml schema, Prisma client, `apps/api/openapi.json`, `packages/api-client` types) |
| Lint everything (ESLint + typecheck) | `pnpm lint`                                                                                                  |
| Format                               | `pnpm format` (check only: `pnpm format:check`)                                                              |
| Unit tests (TS, affected)            | `pnpm nx affected -t test` (vitest everywhere, including the API)                                            |
| Go tests                             | `go test ./agent/... ./cli/... ./lib/...`                                                                    |
| Go lint                              | `golangci-lint run ./agent/... ./cli/... ./lib/...`                                                          |
| Integration tests                    | `pnpm test:integration` (real PostgreSQL via Testcontainers, or `DATABASE_URL` when set)                     |
| Prisma CLI                           | `pnpm prisma <command>` (uses `apps/api/prisma.config.ts`)                                                   |
| Run control plane locally            | `pnpm dev` (API + web + Postgres via `deploy/dev/compose.yml`)                                               |
| Run an agent locally                 | `go run ./agent/cmd/shipkeep-agent --dev`                                                                    |
| Proto checks                         | `buf lint && buf breaking --against '.git#branch=main'`                                                      |

If a command in this table does not exist yet, creating it is part of the current task.

## Architecture rules (never break these)

1. **No shell string building, anywhere.** Never call `sh -c`, `bash -c`, `exec.Command` with user-influenced strings, or Node `child_process` with a shell. The agent talks to Docker through the Docker Engine API (Go SDK) and to Caddy through its admin API. If something truly needs a process, use an argv array with validated, allow-listed arguments, and add a test.
2. **The agent action list is closed.** Every action is a message in `proto/shipkeep/agent/v1/actions.proto`. Adding or changing an action requires: an ADR or SPEC update, input validation in the agent, unit tests including malicious inputs, and the `security-review` label on the PR.
3. **The agent never executes on the host.** Container exec sessions are allowed (typed, audited, RBAC-checked). Host shell access does not exist.
4. **The control plane never holds SSH keys.** Agents enroll with a one-time join token and get a short-lived mTLS client certificate.
5. **Domain code is pure.** `packages/domain` and each API module's `domain/` folder import nothing from NestJS, Prisma, HTTP or the file system.
6. **Every state change is audited.** Commands produce domain events (`createEvent` from `packages/domain`) and publish them on `DomainEventBus` after the change; the `audit` module appends one `AuditEvent` row per event and a store failure fails the command. No write path skips this.
7. **Destructive actions require explicit confirmation.** Deleting a volume, a database, a server or an environment needs a confirmation token from the user. No destructive default is ever `true`.
8. **Secrets never touch logs, `shipkeep.yml`, URLs or error messages.** Use the `Secret` type wrappers (`lib/secret` in Go); they redact on serialization.
9. **The proto and the JSON Schema are the contract.** Generated code is never edited by hand. Change the source, run `pnpm gen`.
10. **Agents must survive a control plane outage.** Running workloads and routing keep working from the agent's local state.

## Code conventions

### TypeScript (api, web, packages)

- Strict TypeScript. No `any` (use `unknown` and narrow). No non-null assertions without a comment.
- API structure per bounded context: `modules/<context>/{domain,application,infrastructure,interface}`.
  - `domain`: entities, value objects, domain events, domain services. Pure.
  - `application`: command and query handlers (CQRS), ports (interfaces).
  - `infrastructure`: Prisma repositories, gRPC client to agents, external adapters.
  - `interface`: REST controllers, DTOs, guards.
- Validation at the edge with `class-validator` DTOs; domain invariants enforced inside entities.
- Errors: domain errors extend `DomainError` from `packages/domain` (kind + stable `code`); the global `ProblemDetailsFilter` maps them to RFC 9457 problem details (`application/problem+json`, `type` = `https://shipkeep.dev/problems/<code>`). Never throw raw `Error` for expected conditions.
- Configuration comes from `AppConfig` (zod-validated environment). Values that embed credentials are `Secret` instances from `packages/domain`; call `expose()` only at the point of use.
- Secret values at rest go through `EnvelopeService.encryptFor(scope, purpose, bytes)` (platform/crypto); never call the primitives or store a DEK yourself.
- Integration tests apply migrations with `src/testing/apply-migrations.ts` (plain SQL through `pg`), never by spawning the Prisma CLI.
- Platform code (`src/platform`) is shared infrastructure; bounded contexts live in `src/modules/<context>` and never import each other's `infrastructure/`.
- Angular: standalone components, signals, OnPush everywhere, feature folders, no business logic in components (use services/stores).

### Go (agent, cli)

- `cmd/` for binaries, `internal/` for everything else. No exported packages unless shared on purpose.
- Context on every call that can block. No goroutine without a clear owner and shutdown path.
- Errors wrapped with `%w`; no panics outside `main`.
- Agent operations are journaled before execution (see SPEC, "Operation journal") so they can resume after a restart.

### Tests

- TDD for domain logic: write the failing test first.
- Unit tests next to the code (`*.spec.ts`, `*_test.go`).
- Integration tests use real Postgres and real Docker (Testcontainers), never mocks of those.
- Every agent action has a test with malicious input (path traversal, injection characters, oversized values).
- Coverage targets: domain packages 90%, application layer 80%, agent `internal/actions` 90%.

## Git and GitHub workflow

- Never push to `main`. One branch and one PR per task from `docs/PLAN.md`: `feat/<task-id>-short-name`, `fix/...`, `chore/...`.
- Conventional Commits (`feat(agent): ...`, `fix(api): ...`). Reference the task id in the PR title: `[M1.3] ...`.
- PR description: what changed, why, how it was tested, security considerations, checklist below.
- Keep PRs small (aim under 500 changed lines excluding generated code).
- Never commit anything from the "Never commit" list below. Secret values for CI are set by the human with `gh secret set` (see `docs/GITHUB_SETUP.md`).
- Do not change branch protection, repository visibility or org settings unless the task says so.

## Never commit

The repository will be public at v1 and git history is forever. Treat every commit as public from day one.

**Secrets and credentials**

- `.env` files of any kind (only `.env.example` with fake values is allowed).
- Private keys and certificates: `*.pem`, `*.key`, `*.crt`, `*.p12`, `*.pfx`, `*.jks`, SSH keys (`id_*`), WireGuard keys, age or cosign keys.
- Shipkeep runtime secrets: the KEK file, internal CA material, agent certificates, join tokens, confirmation signing keys.
- Tokens of any provider: GitHub, GitLab, Hetzner (`HCLOUD_TOKEN`), S3 access keys, SMTP passwords, Slack/Discord/Telegram webhooks, OIDC client secrets.
- Cloud or tool credential files: `.aws/`, `.docker/config.json`, `kubeconfig`, `.netrc`, `.npmrc` with auth tokens, `*.tfstate`.

**Data**

- Database files and dumps: `*.sqlite`, `*.db`, `*.dump`, `*.sql` dumps, `*.sql.gz`, backup archives, `deploy/dev/data/`.
- Real user or customer data of any kind, including in test fixtures. Fixtures use obviously fake values (`example.com`, `sk_test_fake_...`).
- Logs, crash dumps, HAR files, screenshots that show tokens or private dashboards.

**Build output and local state**

- `node_modules/`, `dist/`, `coverage/`, `.nx/` cache, `.angular/`, compiled Go binaries, `tmp/`.
- E2E run state: VM inventories, generated SSH keys, IP lists.
- Editor and assistant local files: `.idea/`, personal `.vscode/settings.json`, `.claude/settings.local.json`.

**Private documents**

- Business documents outside `docs/` (pricing negotiations, customer names, contracts, the French planning document). Only the English docs in `docs/` belong in the repository.

**Exception:** generated code from `pnpm gen` (proto, schema, `openapi.json`, api-client types) is committed on purpose (ADR 0001). The Prisma client (`apps/api/src/platform/prisma/generated/`) is the one generated artifact that is not committed: `pnpm install` regenerates it.

**Enforcement**

- `.gitignore` covers the patterns above; extend it when a new kind of file appears.
- A pre-commit hook (lefthook, installed by `pnpm install`) runs gitleaks on staged files, blocks files over 1 MB unless marked `shipkeep-large-ok` in `.gitattributes`, and formats staged files. A commit-msg hook enforces Conventional Commits. Hook scripts live in `tools/git-hooks/`. `gitleaks` must be installed locally (https://github.com/gitleaks/gitleaks#installing).
- CI runs gitleaks on the full history (security workflow).
- If a secret is ever committed: stop, tell the maintainer, rotate the secret first, then clean the history. Removing it in a later commit is not enough.

## Definition of done (every PR)

- [ ] Acceptance criteria of the task in `docs/PLAN.md` are met.
- [ ] `pnpm lint`, TS tests, Go tests, `buf lint` all pass locally and in CI.
- [ ] New behavior has tests; malicious-input tests for anything touching the agent or user input.
- [ ] No new shell invocation; no new secret exposure path.
- [ ] Audit events emitted for new state changes.
- [ ] Docs updated (SPEC, ARCHITECTURE or an ADR) if a contract or a decision changed.
- [ ] Security workflow (CodeQL, Semgrep, gosec, gitleaks) green.

## When unsure

- If the spec is ambiguous, choose the option that is more secure and more reversible, write the assumption in the PR description, and add it to "Open questions" in `docs/SPEC.md`.
- If a task requires a decision not covered by an ADR (new dependency with a non-permissive license, new external service, change to the agent action list, change to data model invariants), stop and ask before implementing.
- Allowed licenses for dependencies: MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0. Anything else needs approval.
