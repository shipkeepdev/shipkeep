# Shipkeep Threat Model

Living document. Update it in the same PR as any change to the agent, authentication, secrets, builds or the action catalogue.

## Assets

1. User servers (root-equivalent access through Docker).
2. Application secrets and database credentials.
3. User data in volumes, databases and backups.
4. Control plane database, internal CA private key, KEK.
5. Source code access tokens (GitHub App private key, GitLab tokens).
6. Integrity of deployed images and of Shipkeep's own release artifacts.

## Trust boundaries

```text
Internet users ──HTTPS──> Caddy on nodes ──> app containers
Team members ──HTTPS──> Control plane API/UI
Git providers ──webhooks──> Control plane API
Agents ──mTLS gRPC (outbound)──> Control plane agent gateway
Nodes <──WireGuard──> Nodes
Build containers (untrusted code) inside rootless BuildKit
```

## Lessons from Coolify's 2025-2026 CVEs

| Coolify flaw class                               | Example                                                    | Shipkeep mitigation                                                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Command injection from UI fields into host shell | Git source fields, `network` parameter, image name handler | No shell anywhere; typed actions; agent-side validation; CI rule blocking `exec.Command` with non-literal args and Node `child_process` |
| Docker Compose injection to RCE                  | Compose content executed with host privileges              | Compose parsed and validated by the control plane; dangerous keys rejected (SPEC 2.2); containers created through typed `ContainerSpec` |
| Build context escape to host                     | Helper image build executing host commands                 | Rootless BuildKit; no Docker socket in builds; resource limits                                                                          |
| Secret material leaked to low-privileged users   | Root SSH private key readable by members                   | No SSH keys stored; secrets write-only through the API; RBAC tested per endpoint                                                        |
| Missing authorization checks                     | Policy handler without authorization                       | Default-deny guard on every controller; RBAC matrix tests generated for every route                                                     |
| Token injection into host config                 | Sentinel token injection                                   | Tokens are opaque random values, never interpolated into commands or files                                                              |
| Destructive defaults                             | Unused volumes deleted by default                          | Confirmation tokens for destructive actions; no destructive default                                                                     |

## Threats and mitigations (STRIDE)

| Id  | Threat                                              | Mitigation                                                                                                                                                                                                                                                                     | Test                                                                                            |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| S1  | Attacker impersonates an agent                      | mTLS with per-node certs, join tokens single use and short-lived, revocation list                                                                                                                                                                                              | Integration test: revoked cert rejected; reused join token rejected                             |
| S2  | Attacker impersonates the control plane to an agent | Install command carries the installation CA fingerprint; the agent verifies it before sending the join token, then pins that CA (SPEC 3.2)                                                                                                                                     | Agent test with a rogue CA and with a wrong fingerprint                                         |
| S3  | Session hijacking                                   | HttpOnly, Secure, SameSite=Strict cookies, CSRF tokens, session rotation on login and privilege change                                                                                                                                                                         | E2E auth tests                                                                                  |
| T1  | Tampered agent upgrade                              | `UpgradeAgent` verifies cosign signature against embedded key before swap                                                                                                                                                                                                      | Unit test with bad signature                                                                    |
| T2  | Tampered images between registry and node           | Pull by digest only                                                                                                                                                                                                                                                            | Agent rejects tag refs                                                                          |
| T3  | Tampered webhooks                                   | Provider signature verification (HMAC or JWT), replay window 5 min                                                                                                                                                                                                             | API tests                                                                                       |
| R1  | User denies a destructive action                    | Append-only audit log with actor, IP, token id                                                                                                                                                                                                                                 | Audit coverage test: every command emits an event                                               |
| I1  | Secret leakage in logs                              | `Secret` wrapper types redact on serialization; log scrubber for known secret values                                                                                                                                                                                           | Tests that grep logs for secret fixtures                                                        |
| I2  | Cross-tenant data access                            | Organization filter in every repository plus PostgreSQL row-level security                                                                                                                                                                                                     | Tenant isolation test suite runs every endpoint as another org                                  |
| I3  | Backup exposure                                     | Client-side encryption before upload; pre-signed URLs with short TTL                                                                                                                                                                                                           | Restore test with wrong key fails                                                               |
| D1  | Preview environments exhaust resources              | `max_active`, TTL, per-environment resource quotas                                                                                                                                                                                                                             | Scheduler tests                                                                                 |
| D2  | Build exhausts node                                 | Build CPU, memory, time and disk limits                                                                                                                                                                                                                                        | Integration test with a fork bomb Dockerfile                                                    |
| E1  | Container escape to host                            | No privileged, no host namespaces, no host bind mounts, cap allow list, seccomp and AppArmor defaults kept. Docker user-namespace remapping is documented as optional hardening; the installer does not enable it because it changes the Docker daemon configuration (SPEC 14) | Agent tests with malicious specs                                                                |
| E4  | Build escape                                        | `buildkitd` rootless as `shipkeep-build`, outside the `docker` group, no Docker socket (ADR 0012)                                                                                                                                                                              | Integration test: a malicious Dockerfile cannot reach the Docker socket or files of other users |
| E2  | Agent compromise leads to control plane compromise  | Agent identity limited to its node; control plane validates every agent report; agents cannot request actions                                                                                                                                                                  | Gateway authorization tests                                                                     |
| E3  | Developer escalates to protected environment        | RBAC checks on deploy, exec, secrets                                                                                                                                                                                                                                           | RBAC matrix tests                                                                               |

## Security engineering requirements

- Identity mutations lock the user row before security-sensitive changes. Password changes increment the security version and invalidate sessions and reset tokens in the same transaction as their audit. Credential claims are conditional updates; session activity only advances and cannot revive an expired, revoked, disabled-owner or stale-version session. Real PostgreSQL tests cover concurrent mutations and rollback after credential consumption.

- Identity primitives bound password length, Argon2id memory/concurrency and TOTP windows. Tests cover missing accounts, invalid stored hashes, Unicode passphrases, exact session expiry boundaries, RFC 6238 vectors and replayed TOTP counters. Bearer secrets use purpose-separated hashes and redacting wrappers. Persistence must atomically claim counters and recovery codes before authorizing a request.

- Static analysis in CI: Semgrep (custom rules below), gosec, golangci-lint, gitleaks, Trivy filesystem scan. CodeQL (TypeScript, Go) once the repository is public. Trivy image scan of the control plane image is added to the release workflow in task M8.3.
- All third-party GitHub Actions pinned to full commit SHAs and all tool images to digests (the March 2026 trivy-action compromise, CVE-2026-33634, rewrote version tags).
- Custom Semgrep rules in `.semgrep/rules/shipkeep-rules.yml`, failing CI, each proven by `.semgrep/tests/` (`pnpm semgrep:test`):
  - Go: `exec.Command` or `exec.CommandContext` with a non-literal program; any shell interpreter as program (`sh`, `bash`, `dash`, `zsh`, `busybox`, `cmd`, `powershell`, under any path); a `-c` argument; raw spawning through `syscall.Exec`, `syscall.ForkExec`, `os.StartProcess`.
  - Go: Docker `HostConfig` with `Privileged`, or `host` PID, IPC, network or user namespaces.
  - TypeScript: any static or dynamic import of `child_process`, `execa`, `shelljs`, `zx`, `cross-spawn`, `node-pty`.
  - TypeScript: Prisma `$queryRawUnsafe` and `$executeRawUnsafe`.
  - TypeScript: `eval`, `new Function`, string arguments to `setTimeout` and `setInterval`.
- Fuzzing (Go native fuzzing) for: `shipkeep.yml` parser (Go side), Compose validator, every agent action validator, routing table builder.
- Dependency updates through Renovate, security updates merged within 7 days.
- Release artifacts: signed with cosign keyless, SBOM (SPDX) generated with Syft, provenance attestation.
- `SECURITY.md` with a disclosure process and a 90-day disclosure policy from v0.1; a dedicated security email address is added once the project domain is registered.
- External security audit before v1.0.
