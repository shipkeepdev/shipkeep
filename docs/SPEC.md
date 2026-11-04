# Shipkeep Technical Specification

Status: draft for MVP (v0.1). This document is the contract Claude Code implements. When code and spec disagree, fix one of them in the same PR.

## 1. Glossary

| Term             | Meaning                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Organization     | Tenant. Owns members, projects, servers, billing.                                                                                      |
| Project          | Group of environments for one product or one client.                                                                                   |
| Environment      | Isolated deployment target inside a project (`production`, `staging`, previews). Has its own variables, secrets, domains and policies. |
| Node             | A server running `shipkeep-agent`, enrolled in one organization.                                                                       |
| Application      | A deployable unit built from git, an image or a Compose file.                                                                          |
| Service          | One container definition inside a Compose application.                                                                                 |
| Release          | Immutable combination of an image digest and a resolved configuration.                                                                 |
| Deployment       | The process that turns a release into running allocations.                                                                             |
| Allocation       | One running instance of a release (or of a database) on one node.                                                                      |
| Managed database | PostgreSQL, MySQL, MariaDB, MongoDB or Redis run and backed up by Shipkeep.                                                            |
| Action           | A typed command sent from the control plane to an agent.                                                                               |
| Lease            | Time-bound right of a node to run its allocations, with a fencing epoch.                                                               |

## 2. `shipkeep.yml`

### 2.1 Example

```yaml
version: 1
name: billing-api

build:
  type: dockerfile # dockerfile | railpack | nixpacks | image
  context: .
  dockerfile: Dockerfile
  args:
    NODE_ENV: production
  # image: ghcr.io/acme/billing:1.4.2   # only when type = image

run:
  command: ['node', 'dist/main.js'] # argv array only, never a shell string
  port: 3000
  healthcheck:
    path: /health
    interval: 5s
    timeout: 3s
    start_period: 20s
    healthy_threshold: 2

release:
  command: ['node', 'dist/migrate.js'] # runs once per release before the switch
  timeout: 10m

resources:
  cpu: '0.5'
  memory: 512Mi

scale:
  replicas: 2
  placement:
    spread: node # node | none
    labels: { region: eu }
    nodes: [] # optional explicit node names

domains:
  - api.acme.com

env: # non-secret values only
  LOG_LEVEL: info

secrets: # names only; values set in UI, CLI or API
  - DATABASE_URL
  - STRIPE_KEY

volumes:
  - name: uploads
    path: /app/uploads
    backup: { schedule: '0 3 * * *', keep: 14 }

databases:
  - ref: billing-db # managed database in the same environment
    env: DATABASE_URL # inject the connection string as this secret

previews:
  enabled: true
  ttl: 72h
  max_active: 5
  database: clone # none | empty | clone

deploy:
  strategy: rolling # rolling | recreate
  drain_timeout: 30s
  keep_images: 5
```

Compose applications use:

```yaml
version: 1
name: analytics
compose:
  file: docker-compose.yml
  expose:
    - service: web
      port: 8080
      domains: [stats.acme.com]
```

### 2.2 Rules

- Validated against `packages/config-schema/shipkeep.schema.json` (JSON Schema 2020-12). Unknown keys are errors.
- `name`: `^[a-z][a-z0-9-]{1,38}[a-z0-9]$`.
- `run.command`, `release.command`: arrays of strings, max 64 items, each max 4096 bytes. No shell is ever implied.
- Durations: Go-style (`30s`, `10m`, `72h`). Sizes: Kubernetes-style (`512Mi`, `2Gi`).
- Domains: valid hostnames, max 50 per app, wildcard only with DNS-01 configured.
- Volume paths: absolute, no `..`, not under `/proc`, `/sys`, `/dev`, `/etc`, `/var/run`.
- Compose files are parsed and validated by the control plane. Rejected keys: `privileged`, `pid: host`, `network_mode: host`, `ipc: host`, `cap_add` beyond an allow list (`NET_BIND_SERVICE`, `CHOWN`, `SETUID`, `SETGID`), `devices`, bind mounts outside the app's data directory, `security_opt` disabling seccomp or AppArmor, Docker socket mounts.
- Secrets referenced but not set block the deployment with a clear error.

## 3. Agent protocol

### 3.1 Transport

- gRPC over HTTP/2 with mTLS. The control plane exposes `AgentGatewayService` on a dedicated port (default 7443). Names follow buf's STANDARD lint rules (`<Rpc>Request` / `<Rpc>Response`, `Service` suffix).
- The agent calls `Connect(stream ConnectRequest) returns (stream ConnectResponse)` and keeps it open.
- `ConnectRequest` (agent to control plane) carries one of: `Hello`, `Heartbeat`, `ActionUpdate`, `StateReport`.
- `ConnectResponse` (control plane to agent) carries one of: `Welcome`, `ActionRequest`, `CancelAction`, `RoutingTable`, `PeerList`, `LeaseRenewal`, `ConfigUpdate`.
- Logs and metrics do not go through this stream: agents push them directly to VictoriaLogs and VictoriaMetrics (ADR 0011).
- Every `ActionRequest` carries `action_id` (UUIDv7), `idempotency_key`, `deadline`, `lease_epoch` and exactly one action in a `oneof`.
- Interactive exec uses a second RPC: when the agent receives `ExecSession`, it opens `ExecStream(stream ExecStreamRequest) returns (stream ExecStreamResponse)` tagged with the `session_id`, carrying stdin, stdout, stderr, resize and exit frames. Browsers reach it through a WebSocket endpoint on the API (`/api/v1/exec/{session_id}`), authenticated and RBAC-checked; the API only relays frames.

### 3.2 Enrollment

- `Enroll(EnrollRequest{join_token, csr_pem, facts}) returns EnrollResponse{cert_pem, ca_pem, node_id, wireguard_ip, lease_epoch, confirmation_public_key}`. Unary call, server-side TLS only (no client cert yet).
- Trust on first contact: the install command shown in the UI contains the SHA-256 fingerprint of the installation CA (`--ca-fingerprint`). Before sending the join token, the agent checks that the gateway's certificate chains to a CA with that fingerprint, then pins that CA.
- One CA per Shipkeep installation (not per organization). The organization is encoded in each certificate's SAN URI and checked on every call.
- Join token: 32 random bytes, stored hashed (SHA-256), single use, 15 min TTL, bound to an organization.
- Client certificate: Ed25519, 30-day validity, CN = node_id, SAN URI `spiffe://shipkeep/<org_id>/node/<node_id>`. Rotation through `RenewCertificate` at 2/3 of validity.
- Revocation: the control plane keeps a deny list of certificate serials; revoked nodes are disconnected immediately.

### 3.3 Action catalogue (closed list)

Every field below is validated again by the agent. Names are proto message names.

| Action                             | Purpose                                                        | Key fields                                                                                                                                                | Agent-side validation                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EnsureNetwork`                    | Create or confirm a Docker network for an environment          | `name`, `internal`                                                                                                                                        | name matches `^sk-[a-z0-9-]{1,60}$`                                                                                                                                                                                                                                                                            |
| `PullImage`                        | Pull an image                                                  | `image_ref` (always digest pinned), `registry_credentials` (optional, short-lived)                                                                        | ref must contain `@sha256:`; tags are rejected. Built images come from the internal registry; external images (from `build.type: image`, Compose services, managed databases) come from their own registry. The control plane resolves tags to digests when it creates the release, so a release is immutable. |
| `BuildImage`                       | Build with BuildKit rootless and push                          | `repo_url`, `commit_sha`, `git_token` (short-lived, for example a GitHub App installation token), `build_type`, `context`, `dockerfile`, `args`, `limits` | repo URL scheme `https` only; context and dockerfile are relative, no `..`; args keys `^[A-Z_][A-Z0-9_]*$`; limits enforced; token never written to disk or logs                                                                                                                                               |
| `CreateContainer`                  | Create a container from a typed spec                           | `ContainerSpec` (image digest, argv, env, secret refs, ports, mounts, resources, labels, health check, network, dns)                                      | no privileged, no host namespaces, caps from allow list; mounts are only Shipkeep-managed named volumes (`sk-` prefix) or tmpfs; no bind mounts from the host                                                                                                                                                  |
| `StartContainer` / `StopContainer` | Lifecycle                                                      | `container_id`, `stop_timeout`                                                                                                                            | container must carry the `sk.managed=true` label                                                                                                                                                                                                                                                               |
| `RemoveContainer`                  | Remove a container                                             | `container_id`, `remove_volumes=false`                                                                                                                    | `remove_volumes=true` requires a valid confirmation token (section 3.6)                                                                                                                                                                                                                                        |
| `EnsureVolume` / `RemoveVolume`    | Shipkeep-managed named volume lifecycle                        | `name`, `confirmation_token` (remove only)                                                                                                                | name matches `^sk-[a-z0-9-]{1,60}$`; removal needs a valid confirmation token                                                                                                                                                                                                                                  |
| `HealthCheck`                      | Probe an instance                                              | `container_id`, `http_path` or `tcp_port`, thresholds                                                                                                     | path starts with `/`, max 2048 bytes                                                                                                                                                                                                                                                                           |
| `UpsertRoute` / `RemoveRoute`      | Configure Caddy                                                | `route_id`, `hosts`, `upstreams`, `tls_mode`, `drain_timeout`                                                                                             | hostnames valid; upstreams are WireGuard or Docker network addresses only                                                                                                                                                                                                                                      |
| `RunReleaseTask`                   | One-off container for migrations                               | `ContainerSpec`, `timeout`                                                                                                                                | same as `CreateContainer`                                                                                                                                                                                                                                                                                      |
| `ExecSession`                      | Interactive exec inside a managed container                    | `container_id`, `argv`, `tty`, `session_id`                                                                                                               | container must be managed; argv array; session time limit; never the host                                                                                                                                                                                                                                      |
| `BackupVolume` / `RestoreVolume`   | Snapshot a volume to S3 or restore it                          | `volume`, `s3_target` (pre-signed URLs), `encryption_key_ref`                                                                                             | target URLs must be pre-signed and match configured endpoints                                                                                                                                                                                                                                                  |
| `DumpDatabase` / `RestoreDatabase` | Engine-native logical backup and restore                       | `engine`, `container_id`, `s3_target`                                                                                                                     | engine from enum; tool argv built by the agent from fixed templates                                                                                                                                                                                                                                            |
| `ConfigurePeers`                   | Update WireGuard peers                                         | list of `{public_key, endpoint, allowed_ips}`                                                                                                             | keys are 32-byte base64; allowed IPs inside the org's WireGuard CIDR                                                                                                                                                                                                                                           |
| `CollectFacts`                     | Report hardware and software facts                             | none                                                                                                                                                      | none                                                                                                                                                                                                                                                                                                           |
| `UpgradeAgent`                     | Replace the agent binary                                       | `version`, `url`, `sha256`, `cosign_bundle`                                                                                                               | signature verified against the embedded public key before swap                                                                                                                                                                                                                                                 |
| `StopStatefulWorkloads`            | Fencing on stale epoch                                         | `epoch`                                                                                                                                                   | always allowed                                                                                                                                                                                                                                                                                                 |
| `UpgradeControlPlane`              | Upgrade the control plane containers (control plane node only) | `version`, image digests, `cosign_bundle`                                                                                                                 | only accepted by an agent whose node has the `control-plane` role; runs the procedure of ARCHITECTURE section 5                                                                                                                                                                                                |

Anything not in this table does not exist. There is no generic exec, shell or file-write action.

### 3.6 Confirmation tokens

- Issued by the control plane (`POST /api/v1/confirmations`) after the user types the resource name in the UI or passes `--confirm <name>` in the CLI.
- Format: compact JWS signed with EdDSA (Ed25519) by the installation's confirmation key. Claims: `jti`, `org`, `action`, `target`, `iat`, `exp` (5 minutes), `sub` (user).
- The agent receives the public key at enrollment (`confirmation_public_key`), verifies the signature, the expiry, and that `action` and `target` match the request.
- Single use is enforced on both sides: the control plane marks the token used; the agent stores used `jti` values in SQLite until `exp`.

### 3.4 Operation journal

- Local SQLite table `operations(action_id PK, kind, payload_hash, state, step, attempts, started_at, updated_at, last_error)`.
- States: `pending`, `running`, `succeeded`, `failed`, `cancelled`, `compensating`, `compensated`.
- The agent writes `pending` before doing anything, updates `step` after each side effect, and sends `ActionUpdate` on every transition.
- On restart, `running` operations are resumed from `step` if the action is idempotent at that step, otherwise compensated (for example: a half-created container is removed).
- Idempotency: the same `idempotency_key` returns the stored result without re-executing.

### 3.5 Local state

- `desired(resource_id, spec_json, version)`, `actual(resource_id, status_json, observed_at)`, `routing(version, table_json)`, `lease(epoch, expires_at)`, `used_confirmations(jti, expires_at)`.
- `spec_json` stores secret references (name and version), never secret values. See section 9 for how secrets reach containers.
- The agent reconciles its own containers against `desired` every 30 s, restarting crashed managed containers within their restart policy, even without control plane contact.

## 4. Data model

PostgreSQL, one schema `shipkeep`. All tables have `id uuid` (UUIDv7), `created_at`, `updated_at`. Tenant-scoped tables carry `organization_id` and every query filters on it, enforced twice:

- In repositories, which always take the organization id from the request context.
- By PostgreSQL row-level security. The API connects with a role that has RLS enforced. Each request runs its queries in a transaction that starts with `SELECT set_config('app.org_id', $1, true)`, done by a Prisma client extension. Policies compare `organization_id` with `current_setting('app.org_id')::uuid`. Cross-tenant jobs (scheduler, reconciler) use a separate role and are reviewed as security-sensitive code.

| Entity                | Key fields                                                                                                   | Invariants                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `User`                | email (unique, citext), password_hash (argon2id), totp_secret_enc, status                                    | email verified before joining an org                                                     |
| `Session`             | user_id, token_hash, expires_at, ip, user_agent                                                              | 12 h idle timeout, 7 d absolute                                                          |
| `ApiToken`            | owner (user or project), scopes, token_hash, expires_at, last_used_at                                        | shown once; scoped to org and optionally project and environment                         |
| `Organization`        | name, slug                                                                                                   | at least one Owner at all times                                                          |
| `Membership`          | user_id, organization_id, org_role                                                                           | org_role in {owner, admin, member}                                                       |
| `RoleBinding`         | membership_id, project_id, environment_id (nullable), role                                                   | role in {admin, developer, viewer}                                                       |
| `Project`             | name, slug, git_write_mode (commit, pull_request)                                                            | slug unique per org                                                                      |
| `Environment`         | project_id, name, kind (standard, preview), failover_policy, protected                                       | protected envs require Admin for deploy and exec                                         |
| `Node`                | name, status, labels, facts, wireguard_ip, wireguard_public_key, lease_epoch, last_heartbeat_at              | name unique per org                                                                      |
| `NodeCertificate`     | node_id, serial, not_after, revoked_at                                                                       | one active cert per node                                                                 |
| `JoinToken`           | organization_id, token_hash, expires_at, used_at                                                             | single use                                                                               |
| `GitConnection`       | provider, installation_id or credentials_enc, scope                                                          | per org                                                                                  |
| `Application`         | environment_id, name, source (git, image, compose), repo, branch, config_path, config_json, config_sha       | name unique per environment                                                              |
| `Domain`              | application_id, hostname, tls_mode, verification_status                                                      | hostname unique per org                                                                  |
| `Secret`              | environment_id, name, value_enc, version                                                                     | value never returned by the API after creation, only masked                              |
| `Release`             | application_id, image_digest, config_snapshot, commit_sha                                                    | immutable                                                                                |
| `Deployment`          | application_id, release_id, state, trigger, actor_id, started_at, finished_at, error                         | one active deployment per application                                                    |
| `Allocation`          | release_id or database_id, node_id, container_id, state, lease_epoch                                         | stateful allocations bound to one node                                                   |
| `Volume`              | environment_id, name, node_id, size_bytes                                                                    | removal needs confirmation                                                               |
| `ManagedDatabase`     | environment_id, engine, version, node_id, credentials_enc, backup_policy                                     |                                                                                          |
| `BackupTarget`        | organization_id, s3_endpoint, bucket, region, credentials_enc, encryption_key_enc                            | tested on save                                                                           |
| `Backup`              | subject (volume or database), target_id, state, size_bytes, checksum, started_at, finished_at                |                                                                                          |
| `Preview`             | application_id, pr_number, environment_id, expires_at, state                                                 | count per app limited by `max_active`                                                    |
| `AlertRule`           | scope, expression, threshold, window, channel_ids                                                            |                                                                                          |
| `NotificationChannel` | kind (email, slack, discord, telegram, webhook), config_enc                                                  |                                                                                          |
| `AuditEvent`          | organization_id, actor (user, token, system, node), action, target_type, target_id, metadata, ip, created_at | append-only; no update or delete path                                                    |
| `ConfirmationToken`   | organization_id, action, target_id, issued_to, expires_at, used_at                                           | 5 min TTL, single use                                                                    |
| `DataEncryptionKey`   | scope (unique, for example `environment:<id>`), wrapped_key, kek_version, created_at                         | DEK of section 9, wrapped by the KEK; never updated in place, rotation inserts a new row |
| `InstallationKey`     | kind (unique: `ca`, `confirmation`), certificate_pem, public_key_pem, private_key_enc, not_after             | private half encrypted by the KEK; created once at first start                           |

## 5. State machines

### 5.1 Deployment

```text
queued -> building -> built -> releasing -> scheduling -> starting -> health_checking -> switching -> draining -> succeeded
any state -> failed      (previous release keeps serving)
any state -> cancelled   (user cancel; same guarantee)
succeeded -> rolled_back (when a later rollback targets the previous release)
```

- `releasing` is skipped when no release command is defined.
- A failure before `switching` never changes routing.
- A failure during `switching` restores the previous upstream set atomically.

### 5.2 Node

```text
enrolling -> ready -> suspect -> down -> ready (re-joined with epoch check)
ready -> draining -> ready | removed
```

- `suspect` after 15 s without heartbeat, `down` at lease expiry (60 s default).
- `draining`: no new allocations; stateless allocations moved; requires Admin.
- `removed`: certificate revoked, allocations must be zero or confirmed for deletion.

### 5.3 Allocation

```text
pending -> pulling -> created -> starting -> healthy -> stopping -> stopped
starting -> unhealthy -> (restart within policy) -> starting | failed
```

## 6. Scheduling

1. Filter nodes: status `ready`, required labels, architecture matches the image, free CPU and memory reservations, required ports free, volume affinity for stateful workloads.
2. Rank: prefer nodes without another replica of the same app (spread), then lowest reserved memory ratio, then lowest reserved CPU ratio, then node name for determinism.
3. Stateful workloads are pinned to the node that holds their volume.
4. Scheduling is deterministic given the same inputs (unit-testable without a cluster).

## 7. RBAC

Org roles: `owner`, `admin`, `member`. Project or environment roles for members: `admin`, `developer`, `viewer`.

| Capability                    | Owner              | Org admin          | Project admin      | Developer        | Viewer |
| ----------------------------- | ------------------ | ------------------ | ------------------ | ---------------- | ------ |
| Billing, delete organization  | yes                | no                 | no                 | no               | no     |
| Add or remove nodes           | yes                | yes                | no                 | no               | no     |
| Manage members and roles      | yes                | yes                | project only       | no               | no     |
| Create or delete projects     | yes                | yes                | no                 | no               | no     |
| Create or delete environments | yes                | yes                | yes                | no               | no     |
| Deploy to unprotected env     | yes                | yes                | yes                | yes              | no     |
| Deploy to protected env       | yes                | yes                | yes                | no               | no     |
| Read secret values            | no (write-only)    | no                 | no                 | no               | no     |
| Set secrets                   | yes                | yes                | yes                | unprotected only | no     |
| Exec into containers          | yes                | yes                | yes                | unprotected only | no     |
| Delete volumes or databases   | yes (confirmation) | yes (confirmation) | yes (confirmation) | no               | no     |
| View logs and metrics         | yes                | yes                | yes                | yes              | yes    |
| View audit log                | yes                | yes                | project only       | no               | no     |

API tokens carry explicit scopes that can only narrow the owner's permissions.

## 8. Public REST API

- Base path `/api/v1`. OpenAPI 3.1 generated from NestJS decorators and published at `/api/v1/openapi.json`.
- Auth: session cookie (UI, `SameSite=Strict`, CSRF token) or `Authorization: Bearer <api_token>`.
- Errors: RFC 9457 problem details with a stable `type` URI per error.
- Pagination: cursor based (`?cursor=&limit=`, max 100).
- Idempotency: `Idempotency-Key` header supported on all POST endpoints.
- Identity retries use lowercase UUIDv4/v7 keys, scoped to the endpoint, for five minutes. The original body and credential context must match. A PostgreSQL transaction lock serializes the same key across instances; command, audit and retry snapshot commit together. Request/response snapshots are envelope-encrypted (including passwords, codes and session cookies), never stored as plaintext or an offline password-verification hash. This short-lived snapshot is the exception to hash-only credential persistence; it is operational retry state, not a second authentication authority. Expired snapshots are removed in bounded batches, and a failed command creates no reusable result.
- `Idempotency-Replayed` distinguishes a cached success from the first execution. Origin checks and rate limits still apply on retries. Anonymous account actions bind the body; logout additionally binds session, CSRF and authorization headers before returning an already committed result. Replayed login verifies that the cached session remains active; logout, password reset, expiry or privilege changes make it return 409 without cookies. Snapshots expire logically after five minutes; physical cleanup happens in bounded batches on successful new commands. A client must use a new key after expiry or a changed request.
- Rate limits per token and per IP, returned in `RateLimit-*` headers.
- Resources: `/organizations`, `/projects`, `/environments`, `/nodes`, `/join-tokens`, `/applications`, `/applications/{id}/deployments`, `/deployments/{id}` (+ `/cancel`, `/rollback`), `/releases`, `/domains`, `/secrets` (write and list names only), `/databases`, `/volumes`, `/backups`, `/backup-targets`, `/previews`, `/alert-rules`, `/notification-channels`, `/audit-events`, `/api-tokens`, `/confirmations` (issue confirmation tokens), `/imports/coolify`.
- Live updates: `GET /api/v1/events` (SSE), filtered by the caller's permissions.

### 8.1 Identity security parameters

- Account endpoints are `POST /auth/register`, `/auth/verification/request`, `/auth/verify`, `/auth/reset/request`, `/auth/reset`, `/auth/login`, `/auth/logout` and `GET /auth/session`, under `/api/v1`. Signup and mail requests return an empty 202 regardless of account existence/status. Codes are submitted in JSON bodies. Without SMTP configuration, mail requests fail with 503 before account creation. Anonymous browser mutations require the exact `API_PUBLIC_URL` Origin; session mutations also require `X-Shipkeep-CSRF` matching the CSRF cookie. All responses use `Cache-Control: no-store`; JSON/form bodies are capped at 16 KiB. `TRUST_PROXY=none` is the default; `loopback` is available only when the local reverse proxy overwrites forwarding headers and the API is not exposed through another proxy.
- Email identities use lowercase ASCII mailboxes (maximum 254 characters, local part 64); PostgreSQL `citext` enforces case-insensitive uniqueness. Internationalized and quoted mailboxes are outside v0.1.
- Passwords contain 15 to 128 Unicode code points, without trimming, normalization or composition requirements. NUL is rejected. Argon2id v19 uses 64 MiB, three iterations, one lane, a random 16-byte salt and a 32-byte hash. At most two hashes run concurrently per process, with at most 16 waiting callers; overload fails closed.
- Session, verification, reset and API credentials have 256 random bits. Only SHA-256 hashes with a distinct `shipkeep:<purpose>:` prefix are persisted. Email verification expires after 24 hours; password reset after 30 minutes. Session limits remain 12 hours idle and seven days absolute, with equality at either boundary considered expired.
- TOTP uses RFC 6238 SHA-1, a random 160-bit secret, six digits and a 30-second period. Accept the current time step and one adjacent step in either direction. Persist the accepted counter atomically and reject counters already consumed. Ten random 128-bit recovery codes are shown once and stored as purpose-bound hashes; each is consumed atomically.
- Pending TOTP enrollment expires after ten minutes and is tied to the account security version; a password reset invalidates it. The database stores either a pending or active encrypted seed, never both. Activation requires an active account and a current pending version. Disabling MFA removes its recovery hashes; counter and recovery claims join the user's audited transaction so a failed command cannot consume a proof.
- MFA setup and activation require current-password reauthentication; disabling MFA and replacing recovery codes additionally require a fresh TOTP or unused recovery code. Activation, disablement and recovery replacement increment the security version, revoke all older sessions/reset links and return a fresh session atomically. Login grants no session until the active second factor succeeds. Password reset preserves MFA and its recovery mechanism. Recovery use and all MFA management commands are audited without secret values.
- MFA HTTP routes are `GET /auth/mfa` and `POST /auth/mfa/setup`, `/enable`, `/disable`, `/recovery`. Status returns only enabled/pending state and the remaining-code count. Setup returns private provisioning data; activation/recovery replacement return ten private codes, always with no-store headers. Login accepts either `totp` (six digits) or `recovery` (32 lowercase hex characters). MFA mutation limits use the authenticated user ID as well as IP; changing IP does not reset the account limit. Authenticated retry snapshots bind user ID and security version. After credential rotation, retries with a different security context conflict; a user who loses the recovery-code response can sign in with TOTP and regenerate codes after reauthentication.
- TOTP provisioning URIs are secret response data, never navigation URLs or log fields. Secret values stay wrapped until hashing, encryption or an explicitly defined delivery boundary.
- Identity email requires SMTP with implicit TLS (normally port 465), certificate-chain and hostname verification, and TLS 1.2 or newer. Configure `SMTP_HOST` and `SMTP_FROM`, optionally paired `SMTP_USER`/`SMTP_PASSWORD` and a public `SMTP_CA_FILE` for a private issuer. STARTTLS/plaintext SMTP is not supported in v0.1. Delivery has a ten-second inactivity timeout and a twenty-second total deadline. Emails contain a clean page link and a code to paste; the bearer credential is never embedded in a navigation URL. `API_PUBLIC_URL` is an origin without credentials/query/fragment and must use HTTPS in production.
- Authentication limits are persisted in PostgreSQL, independently by operation/IP and operation/subject. Credential operations allow 100 requests per IP and ten per subject in 15 minutes. Signup and email requests allow 20 per IP and five per subject per hour. Subject credential attempts are spaced by 250 ms, doubling up to 64 seconds; rejected retries do not extend the block. Successful login clears only its account delay, never the IP quota. Expired buckets are removed in bounded batches. The HTTP layer returns the applicable quota and retry delay; it must normalize subjects and derive IPs from explicitly trusted proxy configuration.

## 9. Secrets

- Envelope encryption. A key-encryption key (KEK) lives in `/etc/shipkeep/kek` (0400, owned by the service user; 32 raw bytes or their base64) or an external KMS later. Each environment has a data-encryption key (DEK) stored encrypted by the KEK (`DataEncryptionKey`, scope `environment:<id>`). Values are encrypted with AES-256-GCM using the DEK, with associated data that binds the ciphertext to its scope and purpose (`shipkeep:data:<scope>:<purpose>`); blob layout `0x01 | nonce(12) | tag(16) | ciphertext`. The API refuses to start when the KEK file is readable by group or others.
- Secrets are sent to agents only inside `CreateContainer` and `RunReleaseTask`, over mTLS, and passed to containers as environment variables (default) or as files on a tmpfs mount (`secrets_as_files: true`).
- The agent never writes secret values to its SQLite database or its own files; the journal stores a hash of the payload and `desired` stores secret references only.
- Known limitation, documented for users: Docker itself persists a container's environment variables in its container configuration on disk (readable by root only). This is what lets Docker restart a container after a crash or a reboot without the control plane. With `secrets_as_files: true` nothing is persisted, but after a node reboot those containers can only start once the agent has fetched the values from the control plane again.
- The API never returns secret values after creation. The UI shows names, versions and who changed them.
- Rotation of the KEK is a documented admin command that re-encrypts DEKs.

## 10. Backups

- Targets: any S3-compatible storage. Credentials tested on save.
- Databases: engine-native logical dumps (`pg_dump -Fc`, `mysqldump --single-transaction`, `mongodump --archive`, Redis `BGSAVE` + RDB copy), streamed through client-side encryption (age, per-target key) to S3.
- Volumes: `tar` stream of the volume, encrypted the same way. Consistent snapshots for databases use the dump path, not volume tar.
- Schedules in cron syntax with retention (`keep` count). Restore to the same or another node, into the same or a new volume or database.
- Every backup records size and SHA-256. A weekly automatic restore test into a scratch container is available as a policy.
- Instance backup: control plane PostgreSQL, CA material and KEK, to a separate target.

## 11. Previews

- Enabled per application in `shipkeep.yml`. Triggered by PR open and push; destroyed on PR close or TTL expiry.
- Each preview is an `Environment` of kind `preview` cloned from its parent's variables (secrets opt-in per name).
- Hostname: `<app>-pr-<number>.<preview-domain>` (single label, compatible with wildcard certificates).
- `database: clone` restores the parent's latest backup into a new database; `empty` creates a fresh one; `none` reuses nothing.
- `max_active` enforced; the oldest preview is not evicted automatically, the new one is rejected with a PR comment.

## 12. Observability and alerts

- Logs: labels `org`, `project`, `env`, `app`, `service`, `instance`, `node`, `stream`. Search by label and full text. Retention 30 days default.
- Metrics: CPU, memory, network, disk per container and per node; HTTP request rate, latency and status codes per route from Caddy. Retention 30 days.
- Alert rule types for MVP: container restarts, unhealthy instances, node suspect or down, CPU or memory above threshold for a window, disk usage above threshold, backup failed, certificate expiring in under 14 days, deployment failed.
- Channels: email (SMTP), Slack, Discord, Telegram, generic webhook (HMAC signed).

## 13. Coolify import

- Input: Coolify instance URL and API token (read scope), or a Coolify instance backup file.
- Imports: projects, environments, applications (git source, branch, build pack mapped to `build.type`), environment variables (as secrets by default), domains, managed databases (definition only, plus optional data migration through dump and restore).
- Output: a dry-run report first (what maps, what does not), then execution with progress. Generates `shipkeep.yml` per application and opens PRs if git write access is configured.
- Templates: Coolify service templates are converted into `templates/` entries with attribution and license notice.

## 14. Installation and upgrades

- One command: `curl -fsSL https://get.shipkeep.dev | sh` downloads the installer, which verifies signatures and asks before changing anything outside `/opt/shipkeep`, `/etc/shipkeep` and `/var/lib/shipkeep`.
- The installer never rewrites existing Docker daemon configuration; it reports conflicts (ports 80 and 443 in use) and stops with instructions.
- Channels: `stable`, `lts` (from v1), `edge`. Upgrades are manual by default with one click, automatic only if enabled.
- Upgrade procedure as in ARCHITECTURE section 5.

## 15. Non-functional requirements

| Area                 | Requirement                                                                        |
| -------------------- | ---------------------------------------------------------------------------------- |
| Security             | No high or critical finding open in CodeQL, Semgrep, gosec, Trivy at release time  |
| Supply chain         | All release artifacts signed with cosign (keyless), SBOM in SPDX published         |
| Availability         | Running apps and routing unaffected by a control plane outage                      |
| Performance          | Targets in ARCHITECTURE "Resource targets"                                         |
| Compatibility        | Ubuntu 22.04/24.04, Debian 12/13, Rocky/Alma 9; amd64 and arm64; Docker Engine 25+ |
| Accessibility        | Web UI meets WCAG 2.2 AA on core flows                                             |
| Internationalization | English only for v0.1; strings externalized for later translation                  |

## 16. Open questions

- Corrosion adoption for peer-to-peer routing replication (target v0.5).
- Wildcard certificates: which DNS providers to support first for DNS-01 (proposal: Cloudflare, Route 53, Hetzner DNS, OVH).
- Exact Shipkeep Cloud pricing.

## Appendix A: proto skeleton

```proto
syntax = "proto3";
package shipkeep.agent.v1;

service AgentGatewayService {
  rpc Enroll(EnrollRequest) returns (EnrollResponse);
  rpc RenewCertificate(RenewCertificateRequest) returns (RenewCertificateResponse);
  rpc Connect(stream ConnectRequest) returns (stream ConnectResponse);
  rpc ExecStream(stream ExecStreamRequest) returns (stream ExecStreamResponse);
}

// Agent to control plane
message ConnectRequest {
  oneof msg {
    Hello hello = 1;
    Heartbeat heartbeat = 2;
    ActionUpdate action_update = 3;
    StateReport state_report = 4;
  }
}

// Control plane to agent
message ConnectResponse {
  oneof msg {
    Welcome welcome = 1;
    ActionRequest action_request = 2;
    CancelAction cancel_action = 3;
    RoutingTable routing_table = 4;
    PeerList peer_list = 5;
    LeaseRenewal lease_renewal = 6;
    ConfigUpdate config_update = 7;
  }
}

message ActionRequest {
  string action_id = 1;
  string idempotency_key = 2;
  int64 deadline_unix_ms = 3;
  uint64 lease_epoch = 4;
  oneof action {
    EnsureNetwork ensure_network = 10;
    PullImage pull_image = 11;
    BuildImage build_image = 12;
    CreateContainer create_container = 13;
    StartContainer start_container = 14;
    StopContainer stop_container = 15;
    RemoveContainer remove_container = 16;
    EnsureVolume ensure_volume = 17;
    RemoveVolume remove_volume = 18;
    HealthCheck health_check = 19;
    UpsertRoute upsert_route = 20;
    RemoveRoute remove_route = 21;
    RunReleaseTask run_release_task = 22;
    ExecSession exec_session = 23;
    BackupVolume backup_volume = 24;
    RestoreVolume restore_volume = 25;
    DumpDatabase dump_database = 26;
    RestoreDatabase restore_database = 27;
    ConfigurePeers configure_peers = 28;
    CollectFacts collect_facts = 29;
    UpgradeAgent upgrade_agent = 30;
    StopStatefulWorkloads stop_stateful_workloads = 31;
    UpgradeControlPlane upgrade_control_plane = 32;
  }
}
```
