# Shipkeep Implementation Plan (MVP v0.1)

## How to use this plan

- One task = one branch = one PR. Branch name `feat/<task-id>-<slug>` (for example `feat/m1.3-operation-journal`). PR title starts with `[<task-id>]`.
- Do tasks in dependency order. Tasks in different tracks with satisfied dependencies can run in parallel.
- A task is done when every acceptance criterion is met and the definition of done in `CLAUDE.md` passes. Tick the box in this file in the same PR.
- If a task is too big for one PR (over ~500 changed lines excluding generated code), split it into `<task-id>a`, `<task-id>b` and note the split here.
- Create one GitHub issue per task at the start of each milestone (see `docs/GITHUB_SETUP.md`, section 4 "Milestones and issues").
- Branch protection (GITHUB_SETUP section 5) is applied right after M0.2 is merged. M0.1 and M0.2 are merged by the maintainer without required checks.

Tracks: **A** agent (Go), **C** control plane (NestJS), **W** web UI (Angular), **X** cross-cutting.

---

## M0. Foundations

- [x] **M0.1 Repository bootstrap** (X)
  - Nx workspace with pnpm; `apps/api` (NestJS), `apps/web` (Angular), `packages/domain`, `packages/config-schema`, `packages/api-client`, `packages/proto-ts`; `go.work` with the `agent/`, `cli/` and `lib/` modules (paths in CLAUDE.md).
  - Root `package.json` with a `packageManager` field (pnpm version pinned) and the scripts from the CLAUDE.md command table (`pnpm lint`, `pnpm gen`, `pnpm dev`, `pnpm test:integration`); `test:integration` may be a no-op placeholder that exits 0 until M1.2.
  - ESLint (strict, type-aware), Prettier, `.golangci.yml` (config version 2), EditorConfig, `.nvmrc`, `.tool-versions`.
  - Pre-commit hooks with lefthook: gitleaks on staged files, block files over 1 MB, lint-staged formatting. `.env.example` with fake values only.
  - Acceptance: `pnpm install && pnpm lint && pnpm nx run-many -t test && go test ./agent/... ./cli/... ./lib/...` pass on a clean clone; the `ci` and `security` workflows pass on the PR.
- [x] **M0.2 CI and security workflows** (X). Depends: M0.1
  - Harden the existing workflows in `.github/workflows/`: pin every third-party action to a full commit SHA (with the version in a comment) and every tool image to a digest (`semgrep/semgrep`, `gitleaks/gitleaks`); replace `securego/gosec@master` with a pinned release; pin the golangci-lint version so it matches `.golangci.yml`.
  - `release.yml` is only checked with actionlint here; its first dry run happens in M8.2.
  - Acceptance: all checks listed in GITHUB_SETUP section 5 are green on the PR; actionlint passes; no action referenced by a mutable tag.
- [x] **M0.3 Proto and codegen pipeline** (X). Depends: M0.1
  - `buf.yaml` (lint `STANDARD`, breaking `FILE`), `buf.gen.yaml`; `proto/shipkeep/agent/v1/` with the skeleton from SPEC Appendix A and all action messages with fields from SPEC 3.3, 3.6 and the `ExecStream` frames from SPEC 3.1.
  - Generated Go code in `lib/gen`, TS code in `packages/proto-ts`. `pnpm gen` regenerates; CI fails on drift.
  - Acceptance: `buf lint` clean; `buf breaking` wired against `main`; both sides compile.
- [x] **M0.4 shipkeep.yml schema** (X). Depends: M0.1
  - JSON Schema 2020-12 for SPEC section 2 in `packages/config-schema`; generated TS types; Go types and validator in `lib/config`.
  - Golden test files: 20 valid and 30 invalid examples covering every rule in SPEC 2.2.
  - Acceptance: TS and Go validators agree on every golden file (shared test fixture).
- [x] **M0.5 Local dev environment** (X). Depends: M0.1
  - `deploy/dev/compose.yml` with PostgreSQL 17, VictoriaLogs, VictoriaMetrics, a registry; `pnpm dev` starts API and web with hot reload.
  - Acceptance: a new contributor runs the stack with two commands documented in `README.md`.
- [x] **M0.6 Custom Semgrep rules** (X). Depends: M0.2
  - Starter rules already exist in `.semgrep/rules/shipkeep-rules.yml`. Add Semgrep rule tests (`.semgrep/tests/`) proving each rule fires on a bad sample and stays silent on a good one, and extend the rules if THREAT_MODEL requires more.
  - Acceptance: security workflow fails on the bad samples, passes on the codebase.

## M1. Agent core

- [x] **M1.1 Agent skeleton and config** (A). Depends: M0.3
  - `agent/cmd/shipkeep-agent`, config file `/etc/shipkeep/agent.yaml`, structured JSON logging, graceful shutdown, `--dev` mode.
  - Acceptance: binary under 30 MB; starts and stops cleanly; unit tests for config validation.
- [ ] **M1.2 Enrollment and mTLS stream** (A + C). Depends: M1.1, M2.1. Split into M1.2a, M1.2b and M1.2c.
  - [x] **M1.2a** API `fleet` module: join tokens (hashed, single use, 15 min), internal Ed25519 CA with private keys encrypted by the KEK, confirmation signing key, `EnrollNode` and `IssueJoinToken` commands, node and certificate records.
    - Acceptance: CA issues a client certificate from a CSR with the SPIFFE identity decided by the control plane; a reused or expired token is rejected; audit events emitted.
  - [ ] **M1.2b** API `AgentGatewayService` gRPC server over TLS from the installation CA (Connect-RPC): `Enroll`, `RenewCertificate`, client-certificate authentication with the revocation list, CA fingerprint in the install command, join-token REST endpoint once RBAC exists.
  - [ ] **M1.2c** Agent: key generation, CSR, `Enroll`, cert storage (0600), CA fingerprint pinning, `Connect` stream with reconnect and exponential backoff with jitter, cert renewal.
    - Acceptance: integration test enrolls an agent, reconnects after control plane restart, rejects reused token and revoked cert.
- [ ] **M1.3 Operation journal and local state** (A). Depends: M1.1
  - SQLite schema from SPEC 3.4 and 3.5, journal API, resume and compensation framework, idempotency keys.
  - Acceptance: tests kill the agent mid-action (simulated) and verify resume or compensation for each step type.
- [ ] **M1.4 Container actions** (A). Depends: M1.3
  - `EnsureNetwork`, `PullImage`, `CreateContainer`, `StartContainer`, `StopContainer`, `RemoveContainer`, `EnsureVolume`, `RemoveVolume`, `HealthCheck`, `RunReleaseTask` through the Docker Engine SDK, with all validations from SPEC 3.3.
  - Acceptance: integration tests against real Docker; malicious-input tests (privileged, host mounts, path traversal, oversized fields) all rejected; fuzz tests for validators.
- [ ] **M1.5 Caddy route management** (A). Depends: M1.3
  - Caddy installed by the installer; agent manages routes through the admin Unix socket with typed JSON; `UpsertRoute`, `RemoveRoute` with switch-then-drain.
  - Acceptance: test deploys v1, switches to v2 under constant load (k6 or vegeta), zero failed requests.
- [ ] **M1.6 Agent self-reconciliation** (A). Depends: M1.4, M1.5
  - Reconcile loop every 30 s against `desired`; restart crashed managed containers; report `StateReport`.
  - Acceptance: with control plane stopped, a killed container is restarted and routing keeps serving.

## M2. Control plane core

- [x] **M2.1 API skeleton** (C). Depends: M0.1. Split into M2.1a and M2.1b (too big for one PR).
  - [x] **M2.1a** NestJS app with module layout from CLAUDE.md, Prisma, config validation, health endpoints, problem-details errors, OpenAPI generation, request logging with secret redaction.
    - Acceptance: `/api/v1/health` up; OpenAPI document generated in CI; `packages/api-client` generated from it.
  - [x] **M2.1b** Shared foundations used by every later module: KEK loading and the envelope encryption library (SPEC 9), the domain event bus, and the `AuditEvent` table with an append-only writer, so that every command from M1.2 onward emits audit events.
    - Acceptance: encryption library round-trip and tamper tests pass; an example command emits an audit event end to end.
- [ ] **M2.2 Identity** (C + W). Depends: M2.1. Split into reviewable foundations, persistence, account/session flows, MFA/tokens and web flows.
  - [x] **M2.2a** Pure identity policy, bounded Argon2id hashing, purpose-bound token hashes, TOTP counters and recovery-code generation.
  - [x] **M2.2b** Transactional identity persistence and audit, database migrations and concurrent-use tests.
    - [x] **M2.2b1** Request-local unit of work; audit writes join command transactions; real PostgreSQL rollback and isolation tests.
    - [x] **M2.2b2** Identity schema, case-insensitive email uniqueness, bounded credential lifetimes and real PostgreSQL constraint/concurrency tests.
    - [x] **M2.2b3** Identity repositories, per-user mutation locks, session invalidation and atomic token consumption.
  - [x] **M2.2c** Signup, verification, login, sessions, CSRF, reset and brute-force protection.
    - [x] **M2.2c1** Audited account/session commands, single-use email/reset flows, login rotation and concurrent password-reset protection.
    - [x] **M2.2c2** Persistent request limits and progressive login delays shared across API instances.
    - [x] **M2.2c3** Private email delivery with bounded retries.
      - [x] **M2.2c3a** Transactional pg-boss jobs with encrypted payloads, bounded retries and restart/tamper tests.
      - [x] **M2.2c3b** SMTP transport, configuration and TLS delivery tests.
    - [x] **M2.2c4** REST endpoints, secure cookies, origin checks, CSRF and HTTP acceptance tests.
      - [x] **M2.2c4a** Default-deny session and rate-limit guards, host-bound cookies and HTTP boundary tests.
      - [x] **M2.2c4b** Account/session controllers, module wiring, generated API contract and HTTP acceptance tests.
      - [x] **M2.2c4c** Idempotent authentication mutations and concurrent retry tests.
        - [x] **M2.2c4c1** Encrypted retry storage, transaction-bound concurrency control, expiry and rollback tests.
        - [x] **M2.2c4c2** HTTP idempotency keys, credential-bound replay and acceptance tests.
    - [x] **M2.2c5** Strip credential-bearing URL queries and opaque framework errors from HTTP diagnostics and responses.
  - [ ] **M2.2d** TOTP enrollment/recovery and scoped API tokens.
    - [x] **M2.2d1** Encrypted TOTP enrollment storage, version/expiry checks and atomic counter/recovery claims.
    - [ ] **M2.2d2** Audited MFA commands, login proof and session rotation on security changes.
    - [ ] **M2.2d3** MFA HTTP endpoints and acceptance tests.
    - [ ] **M2.2d4** Scoped API tokens and bearer authentication.
  - [ ] **M2.2e** Web identity flows and end-to-end acceptance tests.
  - Sign-up, email verification, login with argon2id, sessions, CSRF, TOTP 2FA with recovery codes, password reset, API tokens with scopes.
  - Acceptance: auth E2E tests; brute-force protection (rate limit and progressive delay); session rotation on privilege change.
- [ ] **M2.3 Organizations, projects, environments, RBAC** (C + W). Depends: M2.2
  - Entities from SPEC 4, RBAC matrix from SPEC 7 as a policy module, default-deny guard, row-level security.
  - Acceptance: generated RBAC matrix test covers every route and role; tenant isolation suite passes.
- [ ] **M2.4 Audit log guarantees and UI** (C + W). Depends: M2.3
  - Database permissions deny update and delete on `AuditEvent`; audit UI with filters; export endpoint.
  - Acceptance: test asserts every command handler emits at least one audit event.
- [ ] **M2.5 Confirmation tokens** (C + W). Depends: M2.3
  - `/confirmations` endpoint, UI confirmation dialog that requires typing the resource name.
  - Acceptance: destructive endpoints reject requests without a valid, unused, matching token.
- [ ] **M2.6 Web UI shell** (W). Depends: M2.2
  - Angular app shell, routing, auth flows, org/project/environment navigation, design tokens, Tailwind, CDK, empty states, SSE client.
  - Acceptance: Lighthouse accessibility score at least 95 on login and dashboard; core flows keyboard-navigable.

## M3. Deploy pipeline

- [ ] **M3.1 Git providers** (C + W). Depends: M2.3
  - GitHub App (installation flow, webhooks, checks API), GitLab, Gitea, Bitbucket via OAuth or tokens. Webhook signature verification.
  - Acceptance: a verified push webhook enqueues a deploy request job with the commit and branch; a forged or replayed webhook is rejected. (Turning the request into a deployment is M3.4.)
- [ ] **M3.2 shipkeep.yml sync** (C + W). Depends: M3.1, M0.4
  - Read config at commit, validate, show drift; UI editor that writes back as commit or PR with diff preview.
  - Acceptance: editing replicas in the UI opens a PR with the exact YAML change.
- [ ] **M3.3 Builds and registry** (A + C). Depends: M1.2, M1.4, M3.1
  - `BuildImage` with rootless BuildKit; Dockerfile, Railpack, Nixpacks, image; internal registry on WireGuard with short-lived tokens; build logs streamed.
  - Acceptance: builds for Node, Python, Go, PHP sample repos; malicious Dockerfile cannot reach the host Docker socket.
- [ ] **M3.4 Deployment state machine** (C). Depends: M3.3, M1.5, M4.3
  - SPEC 5.1 implemented as a domain aggregate with exhaustive transition tests; orchestration via pg-boss jobs.
  - Acceptance: failure injected at every state leaves the previous release serving.
- [ ] **M3.5 Rollback and release history** (C + W). Depends: M3.4
  - Keep N images; one-click rollback; release diff view (image, config).
  - Acceptance: rollback under load with zero failed requests.
- [ ] **M3.6 Domains and TLS** (A + C + W). Depends: M1.5
  - Custom domains, HTTP-01, DNS-01 for Cloudflare first, verification status, certificate expiry tracking.
  - Acceptance: domain added and served over HTTPS in an E2E test.
- [ ] **M3.7 Secrets** (C + W). Depends: M2.3
  - Envelope encryption from SPEC 9; write-only API; env and file injection.
  - Acceptance: secret values never appear in API responses, logs or agent SQLite (test greps for fixtures).
- [ ] **M3.8 Compose applications** (C). Depends: M3.4
  - Compose parser and validator (SPEC 2.2), translated to typed `ContainerSpec`s.
  - Acceptance: 15 popular Compose files deploy; 20 malicious Compose files rejected with clear errors.

## M4. Networking and multi-node

- [ ] **M4.1 WireGuard mesh** (A + C). Depends: M1.2
  - Key generation on node, IP allocation per org CIDR, `ConfigurePeers`, NAT traversal via persistent keepalive and endpoint discovery.
  - Acceptance: three VMs in two providers communicate over the mesh; one behind NAT.
- [ ] **M4.2 Internal DNS and service discovery** (A). Depends: M4.1
  - Embedded DNS on the WireGuard interface for `<app>.<env>.<project>.internal`.
  - Acceptance: app on node A reaches database on node B by name.
- [ ] **M4.3 Scheduler** (C). Depends: M2.3 (pure function; can be built before M3.4, which uses it)
  - SPEC 6 algorithm as a pure function with property-based tests.
  - Acceptance: deterministic placement; spread respected; constraints honored.
- [ ] **M4.4 Routing table distribution** (C + A). Depends: M4.1, M1.5
  - Compute table, version it, push to all agents, cross-node forwarding in Caddy.
  - Acceptance: request to any node reaches the app wherever it runs.
- [ ] **M4.5 Heartbeats, leases, failover, fencing** (C + A). Depends: M4.4
  - ADR 0008 implemented.
  - Acceptance: E2E kills a node; stateless app back on another node in under 90 s; stateful app never runs twice (partition test).

## M5. Data

- [ ] **M5.1 Managed databases** (C + A + W). Depends: M4.2, M3.7
  - PostgreSQL, MySQL, MariaDB, MongoDB, Redis with versions, credentials as secrets, connection string injection.
  - Acceptance: each engine created, connected from an app, restarted without data loss.
- [ ] **M5.2 Backup targets and backups** (C + A + W). Depends: M5.1, M3.7
  - S3 targets tested on save; DB dumps and volume backups with client-side encryption; schedules and retention.
  - Acceptance: backup and restore round trip for each engine and for a volume, checksum verified.
- [ ] **M5.3 Restore anywhere** (C + A + W). Depends: M5.2
  - Restore into another node, a new database or volume; scheduled restore tests.
  - Acceptance: restore to a different node in E2E.
- [ ] **M5.4 Instance backup** (C). Depends: M5.2
  - Control plane DB, CA, KEK to a separate target; documented disaster recovery procedure tested.
  - Acceptance: a fresh control plane restored from backup re-adopts existing agents.

## M6. Observability

- [ ] **M6.1 Log shipping and search** (A + C + W). Depends: M1.4
  - Agent ships logs to VictoriaLogs with labels; UI live tail and search; 30-day retention.
- [ ] **M6.2 Metrics** (A + C + W). Depends: M1.4
  - Container, node and Caddy metrics to VictoriaMetrics; charts in UI.
- [ ] **M6.3 Alerts and notifications** (C + W). Depends: M6.1, M6.2
  - Rule types from SPEC 12; channels email, Slack, Discord, Telegram, webhook.
  - Acceptance: each rule type fires in an integration test and delivers to a test channel.

## M7. Previews

- [ ] **M7.1 Preview environments** (C + A + W). Depends: M3.1, M3.4, M5.2
  - SPEC 11 with TTL, quota, database modes, PR comments, cleanup.
  - Acceptance: open PR creates preview with cloned DB; closing PR removes everything.

## M8. Access and tooling

- [ ] **M8.1 SSO OIDC** (C + W). Depends: M2.2
  - Org-level OIDC (Google, GitHub, Microsoft Entra, Keycloak tested), JIT provisioning with default role, enforce-SSO option.
- [ ] **M8.2 CLI** (X). Depends: M3.5
  - Go CLI commands from ARCHITECTURE; `.goreleaser.yaml` for agent and CLI; Homebrew tap and Scoop bucket; first `release.yml` dry run via workflow_dispatch.
- [ ] **M8.3 Installer and control plane upgrades** (X). Depends: M5.4
  - `get.shipkeep.dev` installer (CA fingerprint pinning, `shipkeep-build` user, cgroup v2 delegation, AppArmor profile on Ubuntu 24.04), signature checks, conflict detection.
  - `deploy/control-plane.Dockerfile`, Trivy image scan in `release.yml`, `UpgradeControlPlane` action with snapshot and rollback.
  - Acceptance: upgrade from previous release to current on a VM, then forced failure triggers automatic rollback.

## M9. Migration

- [ ] **M9.1 Coolify import** (C + W). Depends: M3.8, M5.1
  - SPEC 13 with dry-run report and execution.
  - Acceptance: import of a Coolify v4 test instance with 5 apps and 2 databases.
- [ ] **M9.2 Template catalog** (X). Depends: M3.8
  - Converter for Coolify templates with attribution; first 50 templates curated and tested.

## M10. Hardening and beta

- [ ] **M10.1 E2E suite on real VMs** (X). Depends: M4.5
  - Implement `pnpm e2e:provision`, `pnpm e2e:run`, `pnpm e2e:teardown` used by `.github/workflows/e2e-nightly.yml` (Hetzner Cloud via `hcloud`, resources tagged with the run id, teardown deletes by tag).
  - Scenarios: deploy, rollback, failover, backup and restore, preview, upgrade.
  - Acceptance: nightly run green three nights in a row; no orphaned VMs after a forced failure.
- [ ] **M10.2 Fuzzing and security pass** (X). Depends: M1.4, M3.8
  - Fuzz targets from THREAT_MODEL running in CI for 5 minutes each nightly; fix all findings.
- [ ] **M10.3 Performance budget** (X). Depends: M6.2
  - Measure resource targets from ARCHITECTURE; fail CI on regression beyond 10%.
- [ ] **M10.4 Documentation site** (X). Depends: M8.2
  - User docs: install, concepts, shipkeep.yml reference (generated from schema), CLI reference, migration guide.
- [ ] **M10.5 Private beta** (X). Depends: all above
  - Three external teams onboarded; MVP exit criterion tracked.

## After the MVP (v0.5 to v1)

- Control plane high availability (stateless API, PostgreSQL primary and replica).
- Continuous volume replication between nodes.
- Corrosion-based routing replication (ADR 0006).
- SAML, white label, LTS channel (Enterprise).
- External security audit, then public release under Apache-2.0.
