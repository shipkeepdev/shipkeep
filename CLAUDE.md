# CLAUDE.md

Conventions for AI coding assistants working on Shipkeep. Human contributors should start with [CONTRIBUTING.md](CONTRIBUTING.md); the rules are the same.

## What Shipkeep is

Shipkeep is a self-hosted platform that deploys applications, databases and services to servers the user owns. Every change must protect four properties:

1. **Secure by design.** The control plane holds no SSH key and no shell command is built from strings. Agents open an outbound mTLS connection and execute a closed list of typed actions.
2. **Configuration in the repository.** Each application is described by a versioned `shipkeep.yml`. The UI writes to that file (commit or pull request) instead of hiding state.
3. **Real multi-node.** Placement, health-based failover, a private WireGuard network and replicated routing, without Kubernetes.
4. **Safe upgrades and destructive actions.** Snapshots before upgrades, resumable operations, explicit confirmation for anything destructive.

Read what relates to your change: [product](docs/PRODUCT.md), [architecture](docs/ARCHITECTURE.md), [specification](docs/SPEC.md), [threat model](docs/THREAT_MODEL.md), [roadmap](docs/PLAN.md) and the [decision records](docs/adr/).

## Language

Code, comments, commit messages, pull requests, issues, docs, logs and error messages are in English. UI text is written in English and translated in `apps/web/src/app/ui/fr.ts`.

## Repository layout

```text
apps/
  api/              Control plane API, NestJS (TypeScript)
                      src/platform/   cross-cutting: config, logging, http, prisma, health, openapi, events, crypto
                      src/modules/    bounded contexts, one folder each
                      prisma/         schema and migrations
                      openapi.json    generated REST contract
  web/              Web UI, Angular (design system in apps/web/DESIGN.md)
  landing/          Static marketing page
agent/              Node agent (Go, single static binary)
cli/                CLI (Go, single static binary)
lib/                Shared Go module: generated protobuf code, shipkeep.yml types and validator, Secret wrappers
proto/              gRPC and protobuf contract between control plane and agent
packages/
  domain/           Pure domain model and rules
  config-schema/    JSON Schema for shipkeep.yml, generated types, validator, fixtures
  api-client/       Generated TypeScript client for the REST API
  proto-ts/         Generated TypeScript code from proto/
deploy/             Install script, control plane compose file, systemd units
docs/               Product, architecture, spec, threat model, roadmap, decision records
tools/              Code generation, git hooks, CI and development scripts
```

## Commands

Node.js 22 (`.nvmrc`), pnpm 11, Nx, Go 1.26+ (three modules in one workspace, `go.work`), Docker for integration tests.

| Task                  | Command                                                               |
| --------------------- | --------------------------------------------------------------------- |
| Install               | `pnpm install`                                                        |
| Generate code         | `pnpm gen` (proto, schema, Prisma client, `openapi.json`, API client) |
| Lint and typecheck    | `pnpm lint`                                                           |
| Format                | `pnpm format` (check only: `pnpm format:check`)                       |
| TypeScript unit tests | `pnpm test`                                                           |
| Go tests              | `go test ./agent/... ./cli/... ./lib/...`                             |
| Go lint               | `golangci-lint run ./agent/... ./cli/... ./lib/...`                   |
| Integration tests     | `pnpm test:integration` (real PostgreSQL through Testcontainers)      |
| Browser tests         | `pnpm test:browser` (Chromium against the production build)           |
| Prisma CLI            | `pnpm prisma <command>`                                               |
| Run the control plane | `pnpm dev` (API, web and PostgreSQL)                                  |
| Run an agent          | `go run ./agent/cmd/shipkeep-agent --dev`                             |
| Protobuf checks       | `pnpm proto:lint && pnpm proto:breaking`                              |

## Architecture rules (never break these)

1. **No shell string building, anywhere.** Never call `sh -c`, `bash -c`, `exec.Command` with user-influenced strings, or Node `child_process` with a shell. The agent talks to Docker through the Docker Engine API and to Caddy through its admin API. If something truly needs a process, use an argv array with validated, allow-listed arguments, and add a test.
2. **The agent action list is closed.** Every action is a message in `proto/shipkeep/agent/v1/actions.proto`. Adding or changing one requires an ADR or SPEC update, input validation in the agent, unit tests including malicious inputs, and the `security-review` label.
3. **The agent never executes on the host.** Container exec sessions are allowed (typed, audited, RBAC-checked). Host shell access does not exist.
4. **The control plane never holds SSH keys.** Agents enroll with a one-time join token and get a short-lived mTLS client certificate.
5. **Domain code is pure.** `packages/domain` and each API module's `domain/` folder import nothing from NestJS, Prisma, HTTP or the file system.
6. **Every state change is audited.** Commands publish domain events on `DomainEventBus` after the change; the `audit` module appends one `AuditEvent` per event, and a store failure fails the command. No write path skips this.
7. **Destructive actions require explicit confirmation.** Deleting a volume, a database, a server or an environment needs a confirmation token from the user. No destructive default is ever `true`.
8. **Secrets never touch logs, `shipkeep.yml`, URLs or error messages.** Use the `Secret` wrappers (`lib/secret` in Go, `packages/domain` in TypeScript); they redact on serialization.
9. **The proto and the JSON Schema are the contract.** Generated code is never edited by hand. Change the source and run `pnpm gen`.
10. **Agents must survive a control plane outage.** Running workloads and routing keep working from the agent's local state.

## Code conventions

### TypeScript

- Strict TypeScript. No `any` (use `unknown` and narrow). No non-null assertions without a comment.
- API modules follow `modules/<context>/{domain,application,infrastructure,interface}`. Modules never import each other's `infrastructure/`.
- Validate at the edge with `class-validator` DTOs; domain invariants live inside entities.
- Domain errors extend `DomainError` (kind and stable `code`) and become RFC 9457 problem details. Never throw a raw `Error` for an expected condition.
- Configuration comes from `AppConfig`. Values that embed credentials are `Secret` instances; call `expose()` only at the point of use.
- Secret values at rest go through `EnvelopeService.encryptFor(scope, purpose, bytes)`. Never call the primitives or store a data key yourself.
- Integration tests apply migrations with `src/testing/apply-migrations.ts`, never by spawning the Prisma CLI.
- Angular: standalone components, signals, OnPush, feature folders, no business logic in components. Follow `apps/web/DESIGN.md`. The CSP forbids inline styles and runtime code generation. A screen without a real backend shows the Preview label; it never passes sample data off as live.

### Go

- `cmd/` for binaries, `internal/` for everything else.
- Context on every call that can block. No goroutine without a clear owner and shutdown path.
- Errors wrapped with `%w`; no panics outside `main`.
- Agent operations are journaled before execution, so they can resume after a restart.

### Tests

- Write the failing test first for domain logic.
- Unit tests live next to the code (`*.spec.ts`, `*_test.go`).
- Integration tests use real PostgreSQL and Docker, never mocks of them.
- Every agent action has a test with malicious input: path traversal, injection characters, oversized values.
- Coverage targets: domain packages 90%, application layer 80%, agent `internal/actions` 90%.

## Git workflow

- Never push to `main`. One branch and one pull request per task: `feat/<task-id>-short-name`, `fix/...`, `chore/...`, `docs/...`.
- Conventional Commits (`feat(agent): ...`, `fix(api): ...`), each signed off with `git commit -s` (DCO, checked on every pull request).
- Pull requests say what changed, why, how it was tested and the security considerations, and aim for under 500 changed lines excluding generated code.
- Never change branch protection, repository visibility or organization settings unless the task says so.

## Never commit

Git history is public and permanent: treat anything that reaches a commit as published.

- **Secrets:** `.env` files (only `.env.example` with fake values), private keys and certificates, the KEK file, CA material, join tokens, provider tokens, cloud and tool credential files.
- **Data:** database files and dumps, backups, logs, crash dumps, HAR files, screenshots that show tokens. Fixtures use obviously fake values (`example.com`, `sk_test_fake_...`), never real user data.
- **Local state:** `node_modules/`, `dist/`, `coverage/`, `.nx/`, `.angular/`, compiled binaries, personal editor and assistant settings.

Generated code from `pnpm gen` is committed on purpose (ADR 0001), except the Prisma client, which `pnpm install` regenerates.

`.gitignore` covers these patterns; extend it when a new kind of file appears. The pre-commit hook runs gitleaks, blocks files over 1 MB and formats staged files, and CI scans the full history. If a secret is ever committed, stop and tell the maintainer: rotate it first, then clean the history. Removing it in a later commit is not enough.

## Definition of done

- [ ] Acceptance criteria of the issue are met.
- [ ] Lint, tests and `buf lint` pass locally and in CI.
- [ ] New behavior has tests, with malicious-input tests for anything touching the agent or user input.
- [ ] No new shell invocation and no new secret exposure path.
- [ ] Audit events are emitted for new state changes.
- [ ] SPEC, ARCHITECTURE or an ADR is updated if a contract or a decision changed.
- [ ] The security workflow is green.

## When unsure

- If the spec is ambiguous, choose the more secure and more reversible option, state the assumption in the pull request, and add it to "Open questions" in `docs/SPEC.md`.
- Stop and ask before anything no ADR covers: a dependency outside the allowed licenses (MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0; exceptions are in ADR 0014), a new external service, a change to the agent action list or to data model invariants.
