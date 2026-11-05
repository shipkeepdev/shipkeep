# Shipkeep Implementation Plan (MVP v0.1)

## How to use this plan

- One task = one branch = one PR. Branch name `feat/<task-id>-<slug>` (for example `feat/m1.3-operation-journal`). PR title starts with `[<task-id>]`.
- Do tasks in dependency order. Tasks in different tracks with satisfied dependencies can run in parallel.
- A task is done when every acceptance criterion is met and the definition of done in `CLAUDE.md` passes. Tick the box in this file in the same PR.
- If a task is too big for one PR (over ~500 changed lines excluding generated code), split it into `<task-id>a`, `<task-id>b` and note the split here.
- Create one GitHub issue per task at the start of each milestone (see `docs/GITHUB_SETUP.md`, section 4 "Milestones and issues").
- Branch protection (GITHUB_SETUP section 5) is applied right after M0.2 is merged. M0.1 and M0.2 are merged by the maintainer without required checks.

Tracks: **A** agent (Go), **C** control plane (NestJS), **W** web UI (Angular), **X** cross-cutting.

## Status (2026-11-05)

**Done:**

- M0, M1.1, M1.2 (except fleet administration endpoints, moved to M2.7), M1.3, M2.1 and M2.2.
- M2.3 up to M2.3d4a.

**Verification gap.** GitHub Actions has been blocked by the account spending limit since PR #87. PRs #30 to #39 and #87 to #110 were merged after a local gate instead of CI:

- nx lint, typecheck, unit tests and build;
- `go vet`, `go test -race` and golangci-lint;
- generation drift, Semgrep and Prettier.

Integration tests (Testcontainers), browser acceptance, CodeQL and gosec have **not** run on that code. The first task once Actions is available again is **CI-1**: run the full `ci` and `security` workflows on `main`, then fix every failure in its own `fix/...` PR before any new feature merges.

**Next tasks, in order.** Each is a separate PR and depends on the ones before it unless noted.

1. M2.3f1 and M2.3f2 (administration screens and browser tenant isolation), then M2.4b and M2.5b (audit and confirmation UI) and M2.6.
2. M3 (deploy pipeline), then `StateReport` delivery for M1.6.

**Before going public** (the maintainer changes the visibility; ADR 0016):

- CI-1 green on `main` (#137), and branch protection with required checks (GITHUB_SETUP section 5).
- Full-history gitleaks scan clean. Rotate any credential that was ever committed, even if it was later deleted.
- Enable GitHub private vulnerability reporting and update `SECURITY.md` accordingly.
- Enforce DCO sign-off on pull requests (for example with the DCO GitHub app).
- Review the internal assistant documents (`CLAUDE.md`, `docs/CLAUDE_CODE_KICKOFF.md`, `docs/GITHUB_SETUP.md`) for anything that should not be public.
- Set the repository topics and website, and check the README status line.

**Work that no task owned yet, now assigned:**

| Work                                                                       | Task   |
| -------------------------------------------------------------------------- | ------ |
| Action dispatch over the `Connect` stream (`ActionRequest`/`ActionUpdate`) | M1.4a  |
| `ExecStream`                                                               | M6.1   |
| `CollectFacts`                                                             | M1.6   |
| `UpgradeAgent`                                                             | M8.3   |
| The SSE `/api/v1/events` endpoint                                          | M2.6   |
| Retry-safe certificate renewal (SPEC 16)                                   | M4.5   |
| The web token scope picker                                                 | M2.3f1 |

**Decisions taken (2026-11-05):**

- **CI.** GitHub Actions stays unavailable for now and development continues. Every PR is merged after the local gate, and its description says which checks did not run. CI-1 runs as soon as Actions is back.
- **In-place restores.** `RestoreVolume` and `RestoreDatabase` over an existing target require a confirmation token. Restores into new targets do not (ADR 0013, #112).
- **`argparse`.** It is approved as a per-package license exception (PSF-2.0, ADR 0014).
- **M2.3 role defaults.** The conservative defaults are confirmed and moved from the SPEC 16 open questions into SPEC 7: an environment role replaces the project role, and only owners grant ownership.

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
- [x] **M1.2 Enrollment and mTLS stream** (A + C). Depends: M1.1, M2.1. Split into M1.2a, M1.2b and M1.2c. Acceptance met. The join-token REST endpoint, node list/revoke and the install command with the CA fingerprint moved to M2.7, because they need RBAC and tenant row-level security first.
  - [x] **M1.2a** API `fleet` module: join tokens (hashed, single use, 15 min), internal Ed25519 CA with private keys encrypted by the KEK, confirmation signing key, `EnrollNode` and `IssueJoinToken` commands, node and certificate records.
    - Acceptance: CA issues a client certificate from a CSR with the SPIFFE identity decided by the control plane; a reused or expired token is rejected; audit events emitted.
  - [x] **M1.2b** API `AgentGatewayService` gRPC server over TLS from the installation CA (Connect-RPC): `Enroll`, `RenewCertificate`, client-certificate authentication with the revocation list, CA fingerprint in the install command, join-token REST endpoint once RBAC exists (moved to M2.7).
    - [x] **M1.2b1** Certificate identity checks and atomic certificate renewal with revocation and audit; tests cover concurrent renewals and rollback on audit failure.
    - [x] **M1.2b2** TLS gateway and unary RPC adapters, default-deny client-certificate authentication, revocation checks and transport tests. The CA fingerprint is already returned by `IssueJoinToken`; displaying it in the install command and exposing join tokens remain gated on M2.3/M8.3. `Connect` lifecycle and revocation disconnection are implemented in M1.2c3. `ExecStream` remains authenticated and returns `Unimplemented` until authorized exec sessions exist.
  - [x] **M1.2c** Agent: key generation, CSR, `Enroll`, cert storage (0600), CA fingerprint pinning, `Connect` stream with reconnect and exponential backoff with jitter, cert renewal.
    - [x] **M1.2c1** Ed25519 keys and CSRs, identity-bound credential validation, atomic 0600 credential generations and persistence failure tests.
    - [x] **M1.2c2** Pinned TLS enrollment and certificate renewal client, with rogue-CA and token non-disclosure tests.
    - [x] **M1.2c3** Authenticated gateway stream lifecycle, Hello validation and active revocation checks.
    - [x] **M1.2c4** Agent connection loop, reconnect/backoff, renewal scheduling and real agent/gateway restart integration tests.
      - [x] **M1.2c4a** Stream runner with Hello/Welcome validation, heartbeats, bounded jittered reconnect, key rotation scheduling and cancellation tests.
      - [x] **M1.2c4b** Wire enrollment and the runner into the daemon, consume a private join-token file, and test the actual Go agent against the NestJS gateway through restart/revocation.
    - Acceptance: integration test enrolls an agent, reconnects after control plane restart, rejects reused token and revoked cert.
- [x] **M1.3 Operation journal and local state** (A). Depends: M1.1. Split into M1.3a/b/c for review.
  - [x] **M1.3a** Private SQLite store, exclusive process ownership, durable operation intent/checkpoints/history, idempotency and stale-writer checks.
  - [x] **M1.3b** Versioned desired/actual/routing state, leases and single-use confirmation persistence.
  - [x] **M1.3c** Resumable/compensating step executor, transition notifications, daemon ownership and interruption tests.
  - SQLite schema from SPEC 3.4 and 3.5, journal API, resume and compensation framework, idempotency keys.
  - Acceptance: tests kill the agent mid-action (simulated) and verify resume or compensation for each step type.
- [ ] **M1.4 Container actions** (A). Depends: M1.3. Split: all handlers are done (a, b, c). Only the acceptance remains open: integration tests against a real Docker daemon, to run with CI-1 (#137).
  - [x] **M1.4a** Action dispatch over `Connect`: `ActionRequest` journaled before execution, `ActionUpdate` progress, `CancelAction`, control-plane dispatcher and audit, idempotent redelivery after reconnect.
    - [x] **M1.4a1** Agent side: validated, journaled dispatch with progress updates, idempotent redelivery and cancellation; handlers registered per kind.
    - [x] **M1.4a2** Control-plane side: durable per-node action queue, delivery over the stream, update persistence, redelivery after reconnect, audit.
  - [x] **M1.4b** Docker Engine SDK adapter: `EnsureNetwork`, `PullImage`, `EnsureVolume`, `RemoveVolume` (confirmation token verified with the enrollment public key, `jti` single use).
    - [x] **M1.4b1** Typed Engine API client; `EnsureNetwork`, `PullImage`, `EnsureVolume` handlers with malicious-input and fuzz tests.
    - [x] **M1.4b2** Go confirmation-token verifier (SPEC 3.6) and `RemoveVolume`.
  - [x] **M1.4c** `CreateContainer`, `StartContainer`, `StopContainer`, `RemoveContainer`, `HealthCheck`, `RunReleaseTask`, with validator fuzz tests.
    - [x] **M1.4c1** Container spec validation and `CreateContainer` with confined defaults, malicious-input and fuzz tests.
    - [x] **M1.4c2** `StartContainer`, `StopContainer`, `RemoveContainer` (confirmation when removing volumes).
    - [x] **M1.4c3** `HealthCheck` and `RunReleaseTask`.
  - `EnsureNetwork`, `PullImage`, `CreateContainer`, `StartContainer`, `StopContainer`, `RemoveContainer`, `EnsureVolume`, `RemoveVolume`, `HealthCheck`, `RunReleaseTask` through the Docker Engine SDK, with all validations from SPEC 3.3.
  - Acceptance: integration tests against real Docker; malicious-input tests (privileged, host mounts, path traversal, oversized fields) all rejected; fuzz tests for validators.
- [ ] **M1.5 Caddy route management** (A). Depends: M1.3. The handlers and the typed admin client are done (`UpsertRoute`, `RemoveRoute`). Only the acceptance remains open: a switch under constant load against a real Caddy (CI-1 or the VM suite).
  - Caddy installed by the installer; agent manages routes through the admin Unix socket with typed JSON; `UpsertRoute`, `RemoveRoute` with switch-then-drain.
  - Acceptance: test deploys v1, switches to v2 under constant load (k6 or vegeta), zero failed requests.
- [ ] **M1.6 Agent self-reconciliation** (A). Depends: M1.4, M1.5. Done: the intent journal, the 30 s reconciler restarting stopped managed containers offline, and `CollectFacts`. Remaining: send `StateReport` to the control plane; have the installer run Caddy with `--resume` so routes survive a Caddy restart (M8.3); the end-to-end acceptance on a VM.
  - Reconcile loop every 30 s against `desired`; restart crashed managed containers; report `StateReport`; answer `CollectFacts`.
  - Acceptance: with control plane stopped, a killed container is restarted and routing keeps serving.

## M2. Control plane core

- [x] **M2.1 API skeleton** (C). Depends: M0.1. Split into M2.1a and M2.1b (too big for one PR).
  - [x] **M2.1a** NestJS app with module layout from CLAUDE.md, Prisma, config validation, health endpoints, problem-details errors, OpenAPI generation, request logging with secret redaction.
    - Acceptance: `/api/v1/health` up; OpenAPI document generated in CI; `packages/api-client` generated from it.
  - [x] **M2.1b** Shared foundations used by every later module: KEK loading and the envelope encryption library (SPEC 9), the domain event bus, and the `AuditEvent` table with an append-only writer, so that every command from M1.2 onward emits audit events.
    - Acceptance: encryption library round-trip and tamper tests pass; an example command emits an audit event end to end.
- [x] **M2.2 Identity** (C + W). Depends: M2.1. Split into reviewable foundations, persistence, account/session flows, MFA/tokens and web flows.
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
  - [x] **M2.2d** TOTP enrollment/recovery and scoped API tokens.
    - [x] **M2.2d1** Encrypted TOTP enrollment storage, version/expiry checks and atomic counter/recovery claims.
    - [x] **M2.2d2** Audited MFA commands, login proof and session rotation on security changes.
      - [x] **M2.2d2a** Require atomic TOTP/recovery proof before session creation; rotate sessions and reset links on security changes.
      - [x] **M2.2d2b** Password reauthentication, TOTP setup/activation/disable and recovery-code regeneration.
    - [x] **M2.2d3** MFA HTTP endpoints and acceptance tests.
    - [x] **M2.2d4** Scoped API tokens and bearer authentication.
      - [x] **M2.2d4a** Closed permission vocabulary, scope narrowing and bounded token metadata policy.
      - [x] **M2.2d4b** Token persistence, audited creation/revocation and owner-permission checks.
        - [x] **M2.2d4b1** User-owned token schema/store, bounded expiry, version invalidation and atomic revocation.
        - [x] **M2.2d4b2** Reauthenticated token commands, audited lifecycle and live authorization port.
      - [x] **M2.2d4c** Bearer authentication, per-token limits and HTTP acceptance tests.
        - [x] **M2.2d4c1** Credential authentication, live owner-policy intersection and API traffic quotas.
        - [x] **M2.2d4c2** Session-only token management, default-deny bearer guard and HTTP acceptance tests.
          - [x] **M2.2d4c2a** Default-deny bearer guard, shared traffic limits and profile-read HTTP acceptance.
          - [x] **M2.2d4c2b** Session-only token management endpoints, encrypted retries and generated contract.
  - [x] **M2.2e** Web identity flows and end-to-end acceptance tests.
    - [x] **M2.2e1** Typed browser identity transport, CSRF/idempotency handling and session state.
      - [x] **M2.2e1a** Correct pagination schema and preserve immutable request/response arrays in the generated SDK.
      - [x] **M2.2e1b** Same-origin identity transport and race-safe in-memory session state.
    - [x] **M2.2e2** Accessible signup, verification, login and password-reset screens.
      - [x] **M2.2e2a** Component-scoped submission state, bounded retries, cooldowns and stale-result protection.
      - [x] **M2.2e2b** Validated account forms and private-input lifecycle.
      - [x] **M2.2e2c** Account routes, labeled forms, focus feedback and responsive navigation; browser verification in M2.2e4.
    - [x] **M2.2e3** Account security screens for MFA/recovery and API-token lifecycle.
      - [x] **M2.2e3a** MFA enrollment/recovery form state and temporary private grants.
      - [x] **M2.2e3b** MFA status, manual enrollment and recovery screens; browser verification in M2.2e4.
      - [x] **M2.2e3c** Token creation/revocation form state and paginated metadata.
      - [x] **M2.2e3d** Token-management screens and one-time credential display; browser verification in M2.2e4.
    - [x] **M2.2e4** Browser acceptance and accessibility checks against the real backend, responsive verification and production static serving.
      - [x] **M2.2e4a** Same-origin production web serving and development origin configuration.
      - [x] **M2.2e4b** Real-browser identity/security acceptance with PostgreSQL, accessibility and secret-boundary checks.
        - [x] **M2.2e4b1** Isolated HTTPS/PostgreSQL/SMTP Chromium fixture; public forms, signup/verification/login/logout, secure cookies, CSRF, CSP and automated accessibility checks in CI.
        - [x] **M2.2e4b2** Browser password-reset, MFA/recovery and API-token workflows, failure/retry paths and private-grant lifecycle verification.
      - [x] **M2.2e4c** Desktop/mobile inspection, independent finish review and built design-system documentation.
        - Acceptance: input-boundary contrast and narrow-table cues reviewed at desktop/tablet/mobile sizes; real-browser keyboard navigation preserves form state and reaches token actions. Design system recorded in `apps/web/DESIGN.md`.
  - Sign-up, email verification, login with argon2id, sessions, CSRF, TOTP 2FA with recovery codes, password reset, API tokens with scopes.
  - Acceptance: auth E2E tests; brute-force protection (rate limit and progressive delay); session rotation on privilege change.
- [ ] **M2.3 Organizations, projects, environments, RBAC** (C + W). Depends: M2.2
  - [x] **M2.3a** Pure role matrix, resource-scope checks, protected-environment rules and last-owner policy.
  - [x] **M2.3b** Organization/membership/project/environment schema, tenant-bound relations and database isolation tests.
    - [x] **M2.3b1** Tenant tables, composite foreign keys, unique role scopes and database constraint tests.
    - [x] **M2.3b2** Enforced row-level security and concurrent last-owner database guards.
    - [x] **M2.3b3** Bind existing fleet records to organizations without assigning orphan records to an arbitrary owner.
  - [x] **M2.3c** Tenant transaction context, repositories and audited commands with concurrent last-owner protection.
    - [x] **M2.3c1** Transaction-local tenant context, restricted runtime-role checks and pooled/nested/concurrent transaction tests.
    - [x] **M2.3c2** Runtime-role provisioning, account-bound organization discovery and tenant repositories.
      - [x] **M2.3c2a** Separate runtime/migration credentials, restricted grants, queue upgrade preservation and full-app role acceptance.
      - [x] **M2.3c2b** Account-bound organization discovery and scoped tenant repositories.
        - [x] **M2.3c2b1** Account-scoped discovery policies, mutually exclusive transaction contexts and restricted-login isolation tests.
        - [x] **M2.3c2b2** Tenant authorization repository and live resource-authority queries; mutation repositories land with their audited commands in M2.3c3/c4.
    - [x] **M2.3c3** Audited organization/project/environment commands and rollback acceptance.
      - [x] **M2.3c3a** Pure resource-setting validation, safe defaults and scoped settings permissions.
      - [x] **M2.3c3b** Audited organization creation/settings, creator ownership and session rotation.
        - [x] **M2.3c3b1** Public account-mutation authority with live version checks, reauthentication and transaction-bound session rotation.
        - [x] **M2.3c3b2** Organization persistence, audited commands and atomic owner/session acceptance.
      - [x] **M2.3c3c** Audited project/environment creation/settings and filtered catalog queries.
        - [x] **M2.3c3c1** Tenant-scoped project/environment writes, live role checks and audit rollback acceptance.
        - [x] **M2.3c3c2** Bounded account/tenant catalog queries filtered by current resource grants.
    - [x] **M2.3c4** Membership/binding commands, live authority and privilege-change session invalidation.
      - [x] **M2.3c4a** Ordered actor/subject account locks, reauthenticated privilege changes and atomic credential invalidation.
      - [x] **M2.3c4b** Audited organization membership commands with serialized last-owner protection.
      - [x] **M2.3c4c** Scoped resource-role binding commands and membership/binding queries.
        - [x] **M2.3c4c1** Audited project/environment role assignments, removals and credential invalidation.
        - [x] **M2.3c4c2** Bounded, scope-authorized member/binding administration queries.
  - [x] **M2.3d** Default-deny resource authorization, live API-token authority and protected HTTP endpoints.
    - [x] **M2.3d1** Explicit account/tenant route declarations, canonical path scopes and fail-closed session/bearer guard.
    - [x] **M2.3d2** Live token authority and credential revalidation inside resource commands.
      - [x] **M2.3d2a** Live tenant scope grants and account-locked command credential validation.
      - [x] **M2.3d2b** Resource-command token permissions, actor auditing and bounded query access.
    - [x] **M2.3d3** Organization/project/environment HTTP endpoints and encrypted mutation retries.
      - [x] **M2.3d3a** Session catalogs, scoped resource detail endpoints and generated OpenAPI/client contracts.
      - [x] **M2.3d3b** Resource mutation retry contracts and credential-bound cached-result authorization.
      - [x] **M2.3d3c** Audited resource creation/settings HTTP endpoints and mutation acceptance.
        - [x] **M2.3d3c1** Organization creation/settings endpoints, fresh proof, rotated cookies and transactional retry acceptance.
        - [x] **M2.3d3c2** Project/environment creation/settings endpoints and scoped mutation acceptance.
    - [x] **M2.3d4** Membership/binding HTTP endpoints and generated route/role acceptance matrix.
      - [x] **M2.3d4a** Session-only membership and effective-binding directories with scoped pagination.
      - [x] **M2.3d4b** Membership mutation HTTP, fresh proof, credential rotation and encrypted retries.
      - [x] **M2.3d4c** Project/environment binding mutation HTTP and privilege-change acceptance.
      - [x] **M2.3d4d** Generated registered-route/role matrix and full tenant acceptance checkpoint.
  - [x] **M2.3e** Project-owned tokens constrained by their project and creator's current permissions.
    - [x] **M2.3e1** Project-bound tokens: schema with a composite project key, scopes confined to the project, creator `member.manage` check, per-use project check, cascade on project deletion.
    - [x] **M2.3e2** Project token directory and revocation by project administrators (ordered account locks, audit), plus the web scope picker in M2.3f1.
  - [ ] **M2.3f** Organization/project/environment administration screens and browser/tenant-isolation acceptance.
    - [ ] **M2.3f1** Organization switcher, project/environment catalog and settings, member and binding screens, API-token scope picker.
    - [ ] **M2.3f2** Real-browser acceptance: two organizations, cross-tenant URLs answer 404, role changes take effect on the next request.
  - [x] **M2.3g** Row-level security for the remaining tenant-scoped tables (`nodes`, `join_tokens`, `node_certificates`, `audit_events`), with enrollment token lookup and the agent gateway moved to a separate reviewed cross-tenant role (SPEC 4). Must land before any node, join-token or audit read endpoint is exposed (M2.4, M2.7).
    - [x] **M2.3g1** Fleet tables. `node_certificates` has no `organization_id`: add it with a composite foreign key to `nodes`, rather than relying on a join policy. Gateway lookups use the organization of the verified certificate; enrollment uses a context-bound, SELECT-only token lookup instead of a separate role (ADR 0015).
      - [x] **M2.3g1a** `node_certificates.organization_id` with a composite foreign key to its node, backfilled by migration (ADR 0015).
      - [x] **M2.3g1b** Forced RLS on `nodes`, `join_tokens` and `node_certificates`; tenant-scoped gateway lookups; context-bound enrollment lookup; fleet integration tests on the restricted login.
    - [x] **M2.3g2** `audit_events`: tenant rows readable only in their organization context. System rows (`organization_id` null, for example `fleet.installation_key.created`) are readable by installation administrators only. INSERT stays allowed for every command transaction.
  - Entities from SPEC 4, RBAC matrix from SPEC 7 as a policy module, default-deny guard, row-level security.
  - Acceptance: generated RBAC matrix test covers every route and role; tenant isolation suite passes.
- [ ] **M2.4 Audit log guarantees and UI** (C + W). Depends: M2.3. Partly done: the runtime role has only SELECT/INSERT on `audit_events`, and `runtime-role.integration.spec.ts` proves that UPDATE, DELETE and TRUNCATE are denied.
  - Database permissions deny update and delete on `AuditEvent`; audit UI with filters; export endpoint.
  - [x] **M2.4a** Scoped audit query and JSON Lines export endpoints for organization administrators and `audit.read` tokens. Depends: M2.3g2.
  - [x] **M2.4c** A test that walks every registered mutating route and requires its declared audit events to exist in the code (`apps/api/src/audit-coverage.spec.ts`).
  - [ ] **M2.4b** Audit UI with filters.
  - Acceptance: test asserts every command handler emits at least one audit event.
- [ ] **M2.5 Confirmation tokens** (C + W). Depends: M2.3
  - [x] **M2.5a** `POST /api/v1/confirmations`: EdDSA JWS from the installation confirmation key (SPEC 3.6), the typed resource name checked, `jti` stored and marked used, audited.
    - [x] **M2.5a1** Token format and catalog, Ed25519 signing in the installation key module, `confirmation_tokens` table under RLS, issuance and single-use consumption services.
    - [x] **M2.5a2** HTTP issuance route and the node target resolver.
  - [ ] **M2.5b** Confirmation dialog in the web UI.
  - `/confirmations` endpoint, UI confirmation dialog that requires typing the resource name.
  - Acceptance: destructive endpoints reject requests without a valid, unused, matching token.
- [ ] **M2.6 Web UI shell** (W). Depends: M2.2. Partly done in M2.2e: shell, routing, auth flows, design tokens, Tailwind and CDK. Remaining: org/project/environment navigation (with M2.3f1), empty states, the SSE `/api/v1/events` endpoint and its client, and the Lighthouse check.
  - Angular app shell, routing, auth flows, org/project/environment navigation, design tokens, Tailwind, CDK, empty states, SSE client.
  - Acceptance: Lighthouse accessibility score at least 95 on login and dashboard; core flows keyboard-navigable.
- [ ] **M2.7 Fleet administration endpoints** (C + W). Depends: M2.3d, M2.3g1. Moved from M1.2b.
  - [x] **M2.7a** Join-token issuance (fresh proof, `node.manage`) and node listing, session-only.
  - [x] **M2.7b** Node revocation with a confirmation token and active stream disconnection. Depends: M2.5a.
  - [ ] **M2.7c** Install command with the CA fingerprint in the web UI. Depends: M2.3f1.
  - Join-token issuance endpoint (fresh proof, `nodes.manage` permission), node list, node revocation (confirmation token, active stream disconnected), and an install command that shows the CA fingerprint.
  - Acceptance: an organization admin enrolls a node with the copied command; another organization neither sees the node nor can revoke it.

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
  - [x] **M3.7a** Secrets API: write-only, versioned, environment-encrypted, audited, with the protected-environment rule.
  - [ ] **M3.7b** Secrets screen in the web UI (with M2.3f1).
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
- [x] **M4.3 Scheduler** (C). Depends: M2.3 (pure function; can be built before M3.4, which uses it)
  - SPEC 6 algorithm as a pure function with property-based tests.
  - Acceptance: deterministic placement; spread respected; constraints honored.
- [ ] **M4.4 Routing table distribution** (C + A). Depends: M4.1, M1.5
  - Compute table, version it, push to all agents, cross-node forwarding in Caddy.
  - Acceptance: request to any node reaches the app wherever it runs.
- [ ] **M4.5 Heartbeats, leases, failover, fencing** (C + A). Depends: M4.4
  - ADR 0008 implemented.
  - Retry-safe certificate renewal after a lost response (SPEC 16), so a lease holder is never fenced by its own renewal.
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
  - Restoring over an existing volume or database requires a confirmation token, checked by the agent (ADR 0013); restores into new targets do not.
  - Acceptance: restore to a different node in E2E.
- [ ] **M5.4 Instance backup** (C). Depends: M5.2
  - Control plane DB, CA, KEK to a separate target; documented disaster recovery procedure tested.
  - Acceptance: a fresh control plane restored from backup re-adopts existing agents.

## M6. Observability

- [ ] **M6.1 Log shipping and search** (A + C + W). Depends: M1.4
  - Agent ships logs to VictoriaLogs with labels; UI live tail and search; 30-day retention.
  - `ExecStream`: typed, RBAC-checked and audited container exec sessions (rule 3); the gateway currently answers `Unimplemented`.
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
  - `deploy/control-plane.Dockerfile`, Trivy image scan in `release.yml`, `UpgradeControlPlane` action with snapshot and rollback; `UpgradeAgent` with signature check and rollback to the previous binary.
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
