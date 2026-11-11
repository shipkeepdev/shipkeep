# Shipkeep Technical Specification

Status: draft for MVP (v0.1). This document is the contract the code implements. When code and spec disagree, fix one of them in the same PR.

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
- Compose files are parsed and validated by the control plane, as an allow list that fails closed: a key is translated to what the typed `ContainerSpec` can express, ignored with a warning when it has no effect on safety (`container_name`, `hostname`, `networks`, `logging`), or refused with its reason.
  - Refused among others: `privileged` (even `false`), `pid`, `ipc`, `uts`, `userns_mode`, every `network_mode`, `cap_add` beyond an allow list (`NET_BIND_SERVICE`, `CHOWN`, `SETUID`, `SETGID`), `cap_drop`, `devices`, `security_opt` other than `no-new-privileges` (which the agent always sets), `entrypoint`, `build`, `env_file`, volume and network drivers or `external`.
  - All bind mounts are refused, including inside the application's data directory and the Docker socket: `ContainerSpec` mounts only named volumes and tmpfs. Use named volumes declared under `volumes`.
  - Commands are argv. A string is split only when it holds no shell character, and is otherwise refused.
  - Ports keep only the container port: nothing is published on the host, and `expose` routes traffic. A publication is reported as a warning.
  - `${NAME}` is expanded only in `environment`, and names the secrets the service needs. Bare names that would inherit from the host are refused.
  - Health checks are probed over HTTP or TCP and no command ever runs. A `curl` or `wget` against localhost is read for its URL; any other check is dropped with a warning.
- Secrets referenced but not set block the deployment with a clear error.

## 3. Agent protocol

### 3.1 Transport

- gRPC over HTTP/2 with mTLS. The control plane exposes `AgentGatewayService` on a dedicated port (default 7443). Names follow buf's STANDARD lint rules (`<Rpc>Request` / `<Rpc>Response`, `Service` suffix).
- The gateway uses TLS 1.3 with a distinct server-auth leaf certificate signed by the installation CA. `AGENT_GATEWAY_SERVER_NAME` sets its DNS or IP SAN; the leaf key stays in memory and is refreshed daily. Only `Enroll` permits an absent client certificate. Other RPCs require a TLS-verified client-auth certificate and a current database registration matching its SPIFFE organization and node. Identity headers are ignored. The gateway caps messages at 64 KiB, unary requested deadlines at 30 seconds and streaming requested deadlines at 24 hours. Streams require a matching node/epoch `Hello` first, then a heartbeat at least every 15 seconds (recommended interval: 5 seconds). One active stream per node replaces its predecessor. Credentials are checked at every frame and at least once per second during silence; authentication/database failures close the stream. After Hello, the stream accepts Heartbeat and ActionUpdate frames. Welcome does not grant a durable lease yet (M4.5).

Action delivery (M1.4a2):

- Actions are queued per node in `agent_actions`. That table is under tenant RLS, with a composite key to the node and an idempotency key unique per node. The action message is encrypted per organization and bound to the action id.
- Every stream sends each unfinished action of its node once, at most every second, so a reconnection redelivers everything unfinished. The agent journal replays known idempotency keys.
- Overdue actions become `expired`.
- An agent update changes only its own node's non-terminal actions; terminal states never change again.
- An action the deployment pipeline enqueues records its application and deployment. Both columns are null for other actions. A composite foreign key ties them to a deployment of the same organization and application; deleting the deployment clears them and keeps the action in the node's history.
- An action's history shows a summary, never its raw report: the agent's fixed error texts become reason codes, and a failure refused before anything ran (malformed request, unknown kind, stale lease epoch, invalid input, conflicting idempotency key) is `refused`. Any other text becomes `unknown`. Results keep only validated fields: container id, image digest, health and release exit code.
- Audit: queueing (`fleet.action.queued`) and every terminal state (`fleet.action.<state>`, with the node as actor).
- The agent calls `Connect(stream ConnectRequest) returns (stream ConnectResponse)` and keeps it open. It waits at most 10 seconds for Welcome and uses the advertised heartbeat interval (1–10 seconds supported). Outage retries use exponential backoff with jitter (0.5 seconds initially, capped at 30 seconds); a minute-long healthy session resets the backoff. TLS keepalive detects dead connections. A rejected identity or epoch stops connection attempts and requires operator recovery; it never triggers automatic re-enrollment. Renewal persists the new credential generation before reconnecting.
- `ConnectRequest` (agent to control plane) carries one of: `Hello`, `Heartbeat`, `ActionUpdate`, `StateReport`.
- `ConnectResponse` (control plane to agent) carries one of: `Welcome`, `ActionRequest`, `CancelAction`, `RoutingTable`, `PeerList`, `LeaseRenewal`, `ConfigUpdate`.
- Logs and metrics do not go through this stream: agents push them directly to VictoriaLogs and VictoriaMetrics (ADR 0011).
- Every `ActionRequest` carries `action_id` (UUIDv7), `idempotency_key`, `deadline`, `lease_epoch` and exactly one action in a `oneof`.
- Interactive exec uses a second RPC: when the agent receives `ExecSession`, it opens `ExecStream(stream ExecStreamRequest) returns (stream ExecStreamResponse)` tagged with the `session_id`, carrying stdin, stdout, stderr, resize and exit frames. Browsers reach it through a WebSocket endpoint on the API (`/api/v1/exec/{session_id}`), authenticated and RBAC-checked; the API only relays frames.

### 3.2 Enrollment

- `Enroll(EnrollRequest{join_token, csr_pem, facts}) returns EnrollResponse{cert_pem, ca_pem, node_id, wireguard_ip, lease_epoch, confirmation_public_key}`. Unary call, server-side TLS only (no client cert yet).
- Trust on first contact: the install command shown in the UI contains the SHA-256 fingerprint of the installation CA (`--ca-fingerprint`). The join-token response also carries `gatewayAddress` (`AGENT_GATEWAY_SERVER_NAME` with the gateway port) for the agent's `control_plane.address`; the web UI shows the token once and the agent configuration without it. Before sending the join token, the agent checks that the gateway's certificate chains to a CA with that fingerprint, then pins that CA. The gateway sends its leaf and CA chain during TLS. A payload-free TLS probe verifies the SHA-256 root pin, server certificate chain, validity and hostname; the enrollment RPC then uses that root with normal TLS verification. Only explicit development mode permits a missing initial fingerprint. RPC requests and responses are bounded to 64 KiB, unary calls time out after 30 seconds, and remote error text is never logged.
- One CA per Shipkeep installation (not per organization). The organization is encoded in each certificate's SAN URI and checked on every call.
- Join token: 32 random bytes, stored hashed (SHA-256), single use, 15 min TTL, bound to an organization.
- Enrollment commits the node, certificate, token consumption and audit record in one transaction. A concurrent losing request or an audit failure leaves no orphaned node or certificate.
- Client certificate: Ed25519, 30-day validity, CN = node_id, SAN URI `spiffe://shipkeep/<org_id>/node/<node_id>`. Rotation through `RenewCertificate` at 2/3 of validity. Node and gateway certificates start five minutes before issuance so a node whose clock runs slightly behind accepts them; the 30 days run from issuance. The gateway re-applies its full TLS settings (including the TLS 1.3 minimum) at every certificate refresh. Once a renewal request is sent, the agent finishes it and persists the result even during shutdown, and keeps retrying a failed credential write with bounded backoff instead of discarding the only valid certificate.
- The daemon reads its initial join token from `control_plane.join_token_file`, a regular 0600 file containing the 43-character token and optionally one newline. It never takes the token in argv or YAML. It deletes the token file only after valid credentials are durably saved; subsequent starts use the pinned identity without enrollment. Missing or invalid credentials fail closed in production; an unenrolled development daemon waits for shutdown.
- Agent credentials are stored as one `credentials.json` generation in its private state directory (0700): Ed25519 key, client certificate, pinned CA, node/organization IDs, lease epoch and confirmation public key. The file is 0600, bounded to 64 KiB and validated as a coherent key/identity/CA set before use. Updates sync a temporary file, atomically rename it and sync the directory so renewal cannot leave a new key paired with an old certificate.
- Revocation: the control plane keeps a deny list of certificate serials; existing streams are disconnected within one polling interval (1 second, plus database latency), even without incoming traffic.
- Renewal checks the registered serial, node and organization against the TLS identity. Replacing the certificate, revoking the old serial and recording the audit event share one database transaction; concurrent renewal attempts have one winner. Agents must persist the new certificate and reconnect after renewal. If the response is lost after commit, the old certificate is revoked and the operator must re-enroll the node; recovery without re-enrollment is an open question below.

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
| `UpsertRoute` / `RemoveRoute`      | Configure Caddy                                                | `route_id`, `hosts`, `upstreams`, `tls_mode`, `drain_timeout`                                                                                             | hostnames valid; upstreams are WireGuard or Docker network addresses, or a managed local container with a port that the agent resolves to its private Shipkeep network address (ADR 0017)                                                                                                                      |
| `RunReleaseTask`                   | One-off container for migrations                               | `ContainerSpec`, `timeout`                                                                                                                                | same as `CreateContainer`                                                                                                                                                                                                                                                                                      |
| `ExecSession`                      | Interactive exec inside a managed container                    | `container_id`, `argv`, `tty`, `session_id`                                                                                                               | container must be managed; argv array; session time limit; never the host                                                                                                                                                                                                                                      |
| `BackupVolume` / `RestoreVolume`   | Snapshot a volume to S3 or restore it                          | `volume`, `s3_target` (pre-signed URLs), `encryption_key_ref`, `confirmation_token` (restore only)                                                        | target URLs must be pre-signed and match configured endpoints; restoring over an existing volume needs a valid confirmation token (ADR 0013)                                                                                                                                                                   |
| `DumpDatabase` / `RestoreDatabase` | Engine-native logical backup and restore                       | `engine`, `container_id`, `s3_target`, `confirmation_token` (restore only)                                                                                | engine from enum; tool argv built by the agent from fixed templates; restoring over an existing database needs a valid confirmation token (ADR 0013)                                                                                                                                                           |
| `ConfigurePeers`                   | Update WireGuard peers                                         | list of `{public_key, endpoint, allowed_ips}`                                                                                                             | keys are 32-byte base64; allowed IPs inside the org's WireGuard CIDR                                                                                                                                                                                                                                           |
| `CollectFacts`                     | Report hardware and software facts                             | none                                                                                                                                                      | none                                                                                                                                                                                                                                                                                                           |
| `UpgradeAgent`                     | Replace the agent binary                                       | `version`, `url`, `sha256`, `cosign_bundle`                                                                                                               | signature verified against the embedded public key before swap                                                                                                                                                                                                                                                 |
| `StopStatefulWorkloads`            | Fencing on stale epoch                                         | `epoch`                                                                                                                                                   | always allowed                                                                                                                                                                                                                                                                                                 |
| `UpgradeControlPlane`              | Upgrade the control plane containers (control plane node only) | `version`, image digests, `cosign_bundle`                                                                                                                 | only accepted by an agent whose node has the `control-plane` role; runs the procedure of ARCHITECTURE section 5                                                                                                                                                                                                |

Anything not in this table does not exist. There is no generic exec, shell or file-write action.

The agent reaches Docker through `agent/internal/docker`, a minimal typed Engine API client.

- It talks only to the local `unix://` socket, with API version `v1.47` pinned.
- It exposes only the calls the catalog needs.
- Names are path-escaped and request bodies are typed.
- Responses are capped at 1 MiB, and daemon error text is never echoed.
- Networks are matched by exact name, never by id prefix.

Containers are created from the typed create body in `agent/internal/docker`. That body has no field for privileged mode, host namespaces, devices or bind mounts, so none of them can be requested. The agent always sets:

- `no-new-privileges`, a private IPC namespace and an init process;
- a pids limit (1024 unless specified, at most 65,536);
- bounded `json-file` logs;
- added capabilities from the allow-list only.

The agent also enforces these rules:

- Mounts are managed volumes or bounded tmpfs only, at absolute clean paths outside `/proc`, `/sys`, `/dev`, `/etc`, `/var/run` and `/run`.
- Ports are exposed on the Docker network and never published on the host.
- `secrets_as_files` is refused until the tmpfs writer exists. Secret values are only sent to the local daemon as environment variables.
- Start, stop and remove act only on managed containers, referenced by full id or `sk-` name, never by id prefix. They are idempotent: stopping or removing a missing container is done; starting one fails. Removing a container's volumes needs a `container.remove` confirmation for that container, spent in a non-retryable first step. A token without `remove_volumes` is refused.

Routes (`agent/internal/caddy`, ADR 0005) are typed JSON sent to Caddy's admin API on its Unix socket.

- **Configuration:** the agent owns one `shipkeep` server listening on `:80` and `:443`. It creates only the deepest missing configuration level and never calls `/load`, which would also reset the admin endpoint. Each route is the Caddy object `sk-route-<route_id>`: replaced in place with `PATCH /id/…`, or appended.
- **Hosts:** 1–32 lowercase DNS names (a leading `*.` is allowed); IP addresses and `localhost` are refused.
- **Upstreams:** 1–64 private IP `address:port` literals (Docker or WireGuard networks only), with weights 1–100 mapped to weighted round robin.
- **TLS:** `TLS_MODE_OFF` adds the hosts to the server's `automatic_https.skip` list. DNS-01 is refused until a provider is configured.
- **Switch-then-drain:** `UpsertRoute` switches upstreams atomically and, when it replaced an existing route, waits the drain timeout (default 30 s, at most 5 min) before succeeding, so stopping the old instance comes after draining. `RemoveRoute` also drains after removal.

Self-reconciliation (M1.6, `agent/internal/reconcile`):

- **Intent:** the journal records, per managed container, whether it should run. `StartContainer` sets it after starting; `StopContainer` clears it before stopping, so a stopping container is never restarted; `RemoveContainer` forgets it.
- **Every 30 s,** with or without the control plane, the agent starts each managed container that should run but is not running, and records each observation in the journal's actual state. Missing containers are left to the control plane, because their secrets are not stored on the node.
- **Facts:** `CollectFacts` reports hostname, OS, kernel, architecture, CPU count, memory (`/proc/meminfo`), state-directory disk size and free space, the Docker version and the agent version, without running any command.

State-report collection (M1.6b1) reads Docker's complete managed-container inventory, including stopped containers, every second. It emits on observed changes and every 30 seconds, starting again after each Welcome, with the session epoch and collection-start timestamp. Only canonical container IDs/names, runtime state and `sk.managed` are transmitted; arbitrary labels, environment, commands and health claims are excluded. A container Docker reports as `removing` counts as absent. An invalid inventory, Docker failure, more than 256 managed containers or a frame over 60 KiB suppresses the whole observation, never a partial snapshot; such failures are logged when they start and when they end. Collection runs separately from the single stream writer and stops with its session. The control plane (M1.6b2) rejects a report with a stale epoch on the stream. It ignores a whole report with any invalid container, and otherwise compares it with the placed allocations of the node named by the certificate: containers matching none of them are ignored, a seen container now absent reads as `missing`, and a replica never seen stays unobserved because its container may not exist yet. Observations live in `allocation_observations`, apart from the scheduler's reservation in `allocations`. State changes are audited as `allocation.observed`, by the node; an unchanged state only refreshes `observed_at`, at most once a minute.

`HealthCheck` probes a managed container from the agent:

- **Target:** its private network address only, never loopback, link-local (for example cloud metadata) or public addresses. The port is the requested TCP port, or for HTTP the single exposed TCP port.
- **HTTP:** a `GET` that never follows redirects; 2xx and 3xx count as healthy. The path is absolute and not network-path, printable, at most 2048 bytes.
- **Timing:** interval 1 s–1 min, timeout no longer than the interval, start period up to 10 min, thresholds 1–10, overall deadline up to 30 min.

`RunReleaseTask` runs a validated container spec once, with the restart policy forced to `no`. It creates the container, then starts it, waits for it to exit within its timeout (1 s–1 h) and removes it, all in one non-retryable step, so the exit code is the final result. On timeout the task is killed and removed. After a crash it is compensated (removed), never run again.

Each container is labelled with its name and an `sk.spec` fingerprint of its spec, computed with secret values replaced by their versions. A replay reuses the same container; a different spec under the same name is refused.

The agent only adopts or changes resources that carry its `sk.managed=true` label; a same-named unmanaged network or volume is refused. Image pulls accept only digest-pinned references, plus optional credentials that are short-lived and scoped to the image's own registry. The `sk.` label namespace is reserved for the agent.

### 3.6 Confirmation tokens

- Issued by the control plane (`POST /api/v1/organizations/{organizationId}/confirmations` with `action`, `target` and the typed `name`, 201) after the user types the resource name in the UI or passes `--confirm <name>` in the CLI. Any member may call it. A session needs Origin/CSRF; an API token needs `organization.read` to reach the route and the action's permission in its scopes. The command requires the action's live permission, answers 404 for unknown or hidden targets and 400 `confirmation_name_mismatch` for a wrong name. There is no encrypted retry: a lost response is answered with a new confirmation.
- Format: compact JWS signed with EdDSA (Ed25519) by the installation's confirmation key. Claims: `jti`, `org`, `action`, `target`, `iat`, `exp` (5 minutes), `sub` (user).
- The agent receives the public key at enrollment (`confirmation_public_key`), verifies the signature, the expiry, and that `action` and `target` match the request.
- Single use is enforced on both sides: the control plane marks the token used; the agent stores used `jti` values in SQLite until `exp`.
- Encoding: the header is exactly `{"alg":"EdDSA","typ":"JWT"}`. The payload is exactly `{"jti","org","action","target","sub","iat","exp"}` in that order: UUIDv7 `jti`, `org` and `sub`, `exp = iat + 300`, all base64url without padding. The signature is the raw 64-byte Ed25519 signature of `header.payload`. Verifiers reject any other header, extra or missing claims, non-canonical encodings and tokens over 2 KiB.
- Agent verification (`agent/internal/confirm`):
  - The agent uses the same strict parser and the public key from enrollment.
  - It requires `org` to be its own organization, the action and target to match the request, `iat` at most 60 s ahead and the token unexpired.
  - It records the `jti` in its journal until `exp`.
  - A test vector signed by Node.js checks that the TypeScript and Go implementations agree.
  - `RemoveVolume` needs a token with action `volume.remove` and the volume name as target. The token is spent in a non-retryable first step; the volume is then removed only if it carries `sk.managed=true`. The control plane will issue `volume.remove` confirmations once volumes are resources (M5).
- Actions come from a closed catalog (`modules/confirmations/domain/confirmation-token.ts`), each with the permission its requester needs. The first is `node.remove` (`node.manage`, target = node id).
- Issuance requires the live permission and the resource's exact current name, typed by the user. The control plane stores only the token id, binding, expiry and use time (`confirmation_tokens`, tenant RLS, no DELETE grant), and audits `confirmation.issued`. A destructive command consumes the token inside its own tenant transaction, through one conditional update, so the token is spent only if the command commits.

### 3.4 Operation journal

- Local SQLite table `operations(action_id PK, idempotency_key UNIQUE, kind, payload_hash, state, step, completed, attempts, revision, result_json, started_at, updated_at, last_error)`. SQLite uses WAL and FULL synchronous writes in a private state directory. An exclusive process lock prevents two agents from executing against the same journal. The database file is 0600 and symlinks are rejected.
- Checkpoints use revision compare-and-swap and append an `operation_history` row in the same transaction. Payloads are never stored: only SHA-256 hashes and bounded metadata. Results contain resource ID, image digest and exit code; arbitrary output and raw errors are excluded. Replaying an idempotency key with a different action kind or payload hash fails.
- States: `pending`, `running`, `succeeded`, `failed`, `cancelled`, `compensating`, `compensated`.
- The agent writes `pending` before doing anything, updates `step` after each side effect, and sends `ActionUpdate` on every transition.
- On restart, `running` operations are resumed from `step` if the action is idempotent at that step, otherwise compensated (for example: a half-created container is removed). The executor records the current step before invoking it and advances `completed` only afterwards. Every step declares retry safety and an idempotent compensator; an uncertain non-idempotent step and all preceding steps are compensated in reverse order. Compensation itself is checkpointed and safely retryable. Shutdown leaves recoverable intent instead of converting it to success.
- Journal checkpoints are written even after shutdown is signalled, so a completed side effect is never mistaken for an uncertain one. If announcing a step start fails, the step marker is cleared before returning because the step never ran. A compensator that still fails after five attempts moves the operation to `failed` (terminal, `last_error` recorded) for operator attention instead of retrying on every boot.
- Execution plans are registered code with a version and at most 64 unique step names, never remote code. The intent hash binds the payload hash to the plan version, ordered names and retry policy. The caller reconstructs inputs from desired state or request replay; raw payloads are never journaled. A per-store executor gate prevents concurrent duplicate side effects. Committed transitions are offered to an ActionUpdate callback; delivery failure pauses further effects, and retry republishes the latest durable state. Concrete Docker/Caddy handlers and stream dispatch are wired in their own milestones.
- Idempotency: the same `idempotency_key` returns the stored result without re-executing.
- Dispatch (`agent/internal/actions`) rejects malformed requests before journaling anything, and answers each with a single `FAILED` update carrying a fixed, redacted message. Rejected requests include:
  - an action id that is not a UUIDv7, or an idempotency key outside `[A-Za-z0-9._:-]{1,128}`;
  - a missing or unregistered action kind;
  - a lease epoch other than the node's;
  - a missing or past deadline;
  - a handler validation error.
- The payload hash covers only the action message, so a redelivery with new ids or a new deadline still matches.
- Actions run on the agent's lifetime under their deadline, not the stream's. A dropped connection never interrupts them; their updates are dropped, and the control plane receives the journaled outcome when it redelivers with the same key. `CancelAction` cancels the action's context, and the journal compensates per the plan.

### 3.5 Local state

- `desired(resource_id, spec_json, version)`, `actual(resource_id, status_json, observed_at)`, `routing(version, table_json)`, `lease(epoch, expires_at)`, `used_confirmations(jti, expires_at)`.
- `spec_json` stores secret references (name and version), never secret values. Typed protobuf snapshots are cloned and every `debug_redact` field is cleared recursively before JSON serialization; caller-owned execution data is unchanged. Unknown protobuf fields are removed and snapshots are capped at 1 MiB. See section 9 for how secrets reach containers.
- Desired and routing versions cannot move backwards; same-version replays must have identical canonical JSON. Actual observations cannot regress in time. Lease epochs cannot regress, and a same-epoch expiry cannot shorten. Confirmation IDs are consumed transactionally once until their verified expiry (at most five minutes); signature and scope validation belongs to the confirmation handler.
- The agent reconciles its own containers against `desired` every 30 s, restarting crashed managed containers within their restart policy, even without control plane contact.

## 4. Data model

PostgreSQL. Application tables live in the `public` schema; pg-boss owns `shipkeep_jobs`. All tables have `id uuid` (UUIDv7), `created_at`, `updated_at`. Tenant-scoped tables carry `organization_id` and every query filters on it, enforced twice:

- In repositories, which always take the organization id from the request context.
- By PostgreSQL row-level security. The API connects with a role that has RLS enforced. Tenant operations run through `PrismaUnitOfWork.runTenant`, which binds `SELECT set_config('app.org_id', $1, true)` to the same transaction as repository and audit writes. Policies compare the organization id with that transaction-local setting. Cross-tenant jobs (scheduler, reconciler) use a separate role and are reviewed as security-sensitive code.

Tenant relationships use composite foreign keys carrying the organization id; role bindings also include the environment's parent project, preventing cross-tenant and sibling-project references even through direct SQL. Each membership has one binding per project/environment scope, including the null environment used for a project-wide role. Memberships must be removed explicitly before deleting a user. Organization slugs are globally unique; project slugs are unique per organization; environment names are unique per project. Slugs and environment names use 1–40 lowercase ASCII letters, digits and hyphens, starting with a letter; display names contain 1–80 characters. New projects default to pull-request configuration writes, and environments default to protected with no automatic failover.

Organization, membership, project, environment, role-binding, node, node-certificate and join-token tables enforce RLS for reads and writes, including table-owner queries. Missing or cleared transaction context denies access. Before each tenant operation, the unit of work verifies both login and effective roles, their role memberships, all five forced-RLS tables and the `row_security` setting. It rejects superuser, `BYPASSRLS`, role-administration or replication capabilities, tenant-table ownership, tenant `TRUNCATE`/`TRIGGER` grants and `CREATE` on the public schema. Tenant repositories and route wiring follow in M2.3c2b/M2.3d before HTTP exposure. PostgreSQL superusers and `BYPASSRLS` roles still bypass forced policies, so integration tests use a separate restricted login. See [PostgreSQL row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html).

Fleet operations follow ADR 0015. The agent gateway checks certificates and renews them under `runTenant`, using the organization from the TLS-verified certificate's SPIFFE ID. Enrollment first calls `runEnrollment(tokenHash)`: it sets a transaction-local `app.join_token_hash` with no tenant or account context, so the SELECT-only `join_token_lookup` policy exposes only the join token with that SHA-256 hash. The node, its certificate, the token consumption and the audit event are then written under `runTenant` for the token's organization.

Organization administrators (`node.manage`) manage the fleet over session-only routes. `POST /organizations/{organizationId}/join-tokens` (201) requires Origin/CSRF, the password and the configured second factor. It returns the single-use token, its expiry and the installation CA fingerprint once, and it has no encrypted retry: a lost response is answered with a new token. `GET /organizations/{organizationId}/nodes` returns the organization's nodes (status, labels, sanitized facts, lease epoch, last heartbeat) with `cursor`/`limit`. `POST /organizations/{organizationId}/nodes/{nodeId}/remove` (204) removes a node. It needs `node.manage` (a session, or a scoped token) and a `confirmation` token for `node.remove` on exactly that node, issued to the same account. The token is spent in the same tenant transaction that marks the node `removed`, revokes all its certificates and audits `fleet.node.removed` with the confirmation id. The node's gateway stream closes at its next credential check. Removing it again answers 404.

Audit events are under forced row security too. In a tenant transaction the runtime role reads only that organization's events. It never reads account or system events (`organization_id` null). Appends stay allowed from every command transaction, but a tenant context can only append events of its own organization or of none. No UPDATE or DELETE policy exists. Audit inserts do not read the row back. Reading system events requires an installation-administrator capability that does not exist yet (see section 16).

Organization owners and admins (`audit.read`) read their audit log with `GET /organizations/{organizationId}/audit-events`. It is newest first, with a `cursor` and `limit` (1–100), and optional exact `action`, `targetType`, `targetId` and `actorId` filters plus a `from` (inclusive) and `to` (exclusive) period. `GET .../audit-events/export` returns the same filters as JSON Lines, at most 10,000 events, with `X-Shipkeep-Truncated: true` when older matches remain. Both routes accept a session or a scoped API token with `audit.read`. Reads run in the organization's row security context and are not themselves audited.

Tenant identifiers must be canonical UUIDv7 values. Nested operations can join only the same organization; overlapping sibling scopes within a shared outer transaction are rejected before they can race on connection settings. Context is cleared before returning to an outer identity command and is transaction-local across commit or rollback. Setting a tenant context is not permission to access it: application authorization must still verify current membership and resource ancestry. Storage diagnostics are replaced by an opaque service-unavailable response.

Before choosing an organization, `runAccountDiscovery` sets a transaction-local `app.user_id` from the authenticated account and clears `app.org_id`. SELECT-only policies expose that active, verified account's own memberships and their organization metadata. They expose no other members, project/environment contents or role bindings, and grant no tenant writes. Account discovery and tenant scopes cannot nest into each other or change identity while active; both settings are cleared on exit. An arbitrary account identifier from request input must never be used as the discovery identity.

The migration connection is configured separately with `MIGRATION_DATABASE_URL`; the API reads only its restricted `DATABASE_URL`. Provisioning grants explicit DML on runtime tables and only SELECT/INSERT on audit events, excluding migration tracking and future tables by default. Migrations create the queue schema; pg-boss manages objects only within `shipkeep_jobs` and does not require database-wide schema creation. Upgrade provisioning preserves existing queue objects/jobs while transferring their ownership inside that schema. See [database-role setup](DATABASE_ROLES.md) for development and deployment procedures.

Fleet nodes and enrollment tokens reference an existing organization. Their foreign keys restrict organization deletion instead of cascading into servers, certificates or enrollment history. The fleet migration aborts if legacy rows reference missing organizations; an operator must reconcile these records with their verified owners before retrying the upgrade. It never creates a default owner, reassigns a server or deletes an orphan. Fleet enrollment authorization and transaction boundaries are maintained separately in the M1.2 stack; these foreign keys alone do not grant access or enforce fleet RLS.

Membership writes serialize on the organization through a no-op row update, producing a new row version that also prevents write skew under repeatable-read snapshots. Deferred constraint triggers require at least one owner at commit, allowing atomic creation and ownership transfer. The trigger temporarily selects each affected tenant from stored row identifiers and restores the prior transaction context, so changing context before commit cannot hide the affected organization from the check. It runs with invoker privileges and a fixed search path. Existing ownerless organizations abort migration rather than receiving an invented owner. Deleting the organization permits its membership cascade; user deletion remains restricted while memberships exist.

| Entity                  | Key fields                                                                                                   | Invariants                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `User`                  | email (unique, citext), password_hash (argon2id), totp_secret_enc, status                                    | email verified before joining an org                                                     |
| `Session`               | user_id, token_hash, expires_at, ip, user_agent                                                              | 12 h idle timeout, 7 d absolute                                                          |
| `ApiToken`              | owner (user or project), scopes, token_hash, expires_at, last_used_at                                        | shown once; scoped to org and optionally project and environment                         |
| `Organization`          | name, slug                                                                                                   | at least one Owner at all times                                                          |
| `Membership`            | user_id, organization_id, org_role                                                                           | org_role in {owner, admin, member}                                                       |
| `RoleBinding`           | membership_id, project_id, environment_id (nullable), role                                                   | role in {admin, developer, viewer}                                                       |
| `Project`               | name, slug, git_write_mode (commit, pull_request)                                                            | slug unique per org                                                                      |
| `Environment`           | project_id, name, kind (standard, preview), failover_policy, protected                                       | protected envs require Admin for deploy and exec                                         |
| `Node`                  | name, status, labels, facts, wireguard_ip, wireguard_public_key, lease_epoch, last_heartbeat_at              | name unique per org                                                                      |
| `ConfirmationToken`     | organization_id, user_id, action, target, issued_at, expires_at, used_at                                     | single use; the signed token is never stored (SPEC 3.6)                                  |
| `NodeCertificate`       | organization_id, node_id, serial, not_after, revoked_at                                                      | one active cert per node; `(organization_id, node_id)` references its node (ADR 0015)    |
| `JoinToken`             | organization_id, token_hash, expires_at, used_at                                                             | single use                                                                               |
| `GitConnection`         | provider, installation_id or credentials_enc, scope                                                          | per org                                                                                  |
| `Application`           | environment_id, name, source (git, image, compose), repo, branch, config_path, config (jsonb), config_sha    | name unique per environment                                                              |
| `Domain`                | application_id, hostname (TLS mode and certificate status with M3.6b)                                        | hostname unique per org; synced from the configuration                                   |
| `Secret`                | environment_id, name, value_enc, version                                                                     | value never returned by the API after creation, only masked                              |
| `Release`               | application_id, number, image, image_digest, config, config_sha (commit_sha with git sources)                | immutable; the image digest is recorded once                                             |
| `Deployment`            | application_id, release_id, state, plan (build, release), trigger, actor_id, started_at, finished_at, error  | one active deployment per application                                                    |
| `Allocation`            | release_id (database_id later), node_id, replica, container, port, cpu_millis, memory_bytes, state           | stateful allocations bound to one node; (release, replica) and (node, container) unique  |
| `AllocationObservation` | allocation_id, container_id, state, observed_at                                                              | what the agent last saw; never changes the allocation's reservation                      |
| `Volume`                | environment_id, name, node_id, size_bytes                                                                    | removal needs confirmation                                                               |
| `ManagedDatabase`       | environment_id, engine, version, node_id, credentials_enc, backup_policy                                     |                                                                                          |
| `BackupTarget`          | organization_id, s3_endpoint, bucket, region, credentials_enc, encryption_key_enc                            | tested on save                                                                           |
| `Backup`                | subject (volume or database), target_id, state, size_bytes, checksum, started_at, finished_at                |                                                                                          |
| `Preview`               | application_id, pr_number, environment_id, expires_at, state                                                 | count per app limited by `max_active`                                                    |
| `AlertRule`             | scope, expression, threshold, window, channel_ids                                                            |                                                                                          |
| `NotificationChannel`   | kind (email, slack, discord, telegram, webhook), config_enc                                                  |                                                                                          |
| `AuditEvent`            | organization_id, actor (user, token, system, node), action, target_type, target_id, metadata, ip, created_at | append-only; no update or delete path                                                    |
| `ConfirmationToken`     | organization_id, action, target_id, issued_to, expires_at, used_at                                           | 5 min TTL, single use                                                                    |
| `DataEncryptionKey`     | scope (unique, for example `environment:<id>`), wrapped_key, kek_version, created_at                         | DEK of section 9, wrapped by the KEK; never updated in place, rotation inserts a new row |
| `InstallationKey`       | kind (unique: `ca`, `confirmation`), certificate_pem, public_key_pem, private_key_enc, not_after             | private half encrypted by the KEK; created once at first start                           |

Installation keys are created at application bootstrap, after every module has subscribed to the event bus. Each insert commits with its `fleet.installation_key.created` system audit event (kind and public-key fingerprint, no organization); an instance that loses the creation race uses the stored key and records nothing.

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
- The aggregate is `packages/domain/src/lib/deployment.ts`. A deployment's plan, fixed when it is queued, records whether it builds (image sources skip `building` and `built`) and whether it runs a release command. Stopping it as failed or cancelled reports whether traffic is untouched (before `switching`), must be restored (during it) or already on the new release (`draining`). Failure reasons are stored bounded to 512 characters, without control characters.

- The pipeline planner (`apps/api/src/modules/deployments/domain/pipeline.ts`, PLAN M3.4c3b) is a pure function from what was observed to what comes next. The worker (M3.4c4) applies its decision and calls it again whenever an agent action finishes, so every stage resumes after a restart. Its inputs are the deployment, the release, the placed replicas, the replicas of the serving release and the outcomes of earlier actions. Its decision is one of: resolve the image, place N replicas, enqueue actions (idempotency key `d:<deployment>:<step>`), advance, fail, or done.
  - `queued` resolves the image digest.
  - `releasing` places the replicas, then ensures the environment network, pulls the image and runs the release task on the first replica's node.
  - `scheduling` places the replicas if that was not already done.
  - `starting` ensures the network, pulls, creates and starts each replica.
  - `health_checking` probes `run.healthcheck` on each replica (deadline: the start period plus 2 min, at most 30 min).
  - `switching` upserts the application route (id = application id) on each node with that node's replicas as container upstreams (ADR 0017), but only when `domains` is set.
  - `draining` removes the route from nodes no longer serving, then stops the previous replicas and removes their containers, without their volumes.
  - Any action ending in failed, cancelled, expired or compensated fails the deployment, as do a non-zero release exit, an unhealthy replica or a missing container id.
  - `recovery` then:
    - force-removes the new replicas that were created, which never served traffic;
    - if the switch was interrupted, restores the previous upstreams and removes the route from nodes that only hosted new replicas;
    - does nothing once draining began, because the new release already serves.
  - The worker (`DeploymentPipeline`, run from the pg-boss queue `deployment-run`):
    - The `stately` policy keeps at most one queued and one active run per deployment.
    - Deploying and cancelling send a run in the command's transaction. Every final agent action whose key belongs to a deployment wakes it, and a run that waits on agents is checked again after 15 s.
    - A run applies decisions until the deployment waits or finishes. The image is resolved outside any transaction. Placement uses `placeReplicas` over the nodes as they are observed, and fails with each node's rejection reason when a replica does not fit.
    - Steps are enqueued with the system actor and a one-hour deadline. Transitions compare-and-swap the state, so concurrent runs cannot both apply.
    - Audit events: `release.image_resolved`, `deployment.placed`, `deployment.advanced` (`from`, `to`) and `deployment.failed` (`reason`, `routing`).
    - Success stops the replaced replicas. Failure and cancellation run `recovery` and stop the deployment's own replicas.
    - The worker starts with the agent gateway in `main.ts`.
  - Steps become proto actions in `deployments/infrastructure/agent-steps.ts`. Secret values are injected there at enqueue time, so they travel only inside the encrypted action payload. A full pipeline run is kept as golden vectors (`agent/internal/actions/testdata/control-plane-actions.txt`), and a Go test plans each one with the agent's own handlers, so the planner and the agent validators cannot drift apart.
  - Containers are named `sk-<name[0:24]>-<application id suffix>-r<release>-<replica|task>`, on the network `sk-env-<environment id>`. They carry the labels `shipkeep.application`, `shipkeep.release` and `shipkeep.deployment`; secrets are listed by name, and the worker injects their values.

### 5.2 Node

```text
enrolling -> ready -> suspect -> down -> ready (re-joined with epoch check)
ready -> draining -> ready | removed
```

- `suspect` after 15 s without heartbeat, `down` at lease expiry (60 s default).
- Until leases persist these transitions (M4.5), the control plane records a connected agent's hello and then its heartbeats at most every 10 s. That makes an `enrolling`, `suspect` or `down` node `ready`, audited once per transition as `fleet.node.ready`; `draining` and `removed` nodes keep their status. The API and the scheduler read a stored `ready` node as `suspect` 15 s and `down` 60 s after its last recorded heartbeat.
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

The algorithm is `placeReplica` and `placeReplicas` in `packages/domain/src/lib/scheduler.ts`.

- A stateful workload is pinned only when some node already stores its volume; otherwise it is placed like any other replica and its volume is created there.
- Resource ratios compare exactly (integer cross-multiplication), never as rounded floats.
- `placeReplicas` places replicas one after another, each seeing the reservations, ports and spread of the previous ones, and reports how many did not fit.
- An unplaced replica returns one rejection reason per node: `not_ready`, `architecture`, `labels`, `not_allowed`, `volume`, `cpu`, `memory` or `ports`, checked in that order, for operator explanations.

## 7. RBAC

Org roles: `owner`, `admin`, `member`. Project or environment roles for members: `admin`, `developer`, `viewer`.

| Capability                    | Owner              | Org admin          | Project admin      | Developer        | Viewer |
| ----------------------------- | ------------------ | ------------------ | ------------------ | ---------------- | ------ |
| Billing, delete organization  | yes                | no                 | no                 | no               | no     |
| Add or remove nodes           | yes                | yes                | no                 | no               | no     |
| Manage members and roles      | yes                | yes                | project only       | no               | no     |
| Create or delete projects     | yes                | yes                | no                 | no               | no     |
| Create or delete environments | yes                | yes                | yes                | no               | no     |
| Update organization settings  | yes                | yes                | no                 | no               | no     |
| Update project/env settings   | yes                | yes                | own scope only     | no               | no     |
| Deploy to unprotected env     | yes                | yes                | yes                | yes              | no     |
| Deploy to protected env       | yes                | yes                | yes                | no               | no     |
| Read secret values            | no (write-only)    | no                 | no                 | no               | no     |
| Set secrets                   | yes                | yes                | yes                | unprotected only | no     |
| Exec into containers          | yes                | yes                | yes                | unprotected only | no     |
| Delete volumes or databases   | yes (confirmation) | yes (confirmation) | yes (confirmation) | no               | no     |
| View logs and metrics         | yes                | yes                | yes                | yes              | yes    |
| View audit log                | yes                | yes                | project only       | no               | no     |

API tokens carry explicit scopes that can only narrow the owner's permissions.

Settings use explicit `organization.update`, `project.update` and `environment.update` permissions at their corresponding resource scope; a resource administrator cannot change organization settings. Display names are trimmed and limited to 1–80 Unicode code points without control, format or unpaired-surrogate characters. Slugs and environment names are canonical lowercase ASCII identifiers without whitespace, including trailing newlines. Project/environment configuration values are closed enums; protection is a boolean with no string/number coercion. New projects use pull-request writes and new environments are protected with no automatic failover unless explicitly configured otherwise.

The shared tenant policy is default-deny for unknown permissions, roles and invalid resource hierarchies. Resource ancestry, membership and environment protection must be loaded from current database records by the authorization adapter. Account-only `profile.read` remains outside tenant RBAC. Organization members may read organization metadata; a resource binding permits parent-project navigation but does not grant access to sibling environments. An explicit environment binding replaces the inherited project role for that environment, including when it reduces access. Missing protection metadata denies deploy, secret-write and container-exec decisions even for administrators. Ambiguous duplicate effective bindings are denied.

`TenantAccess` resolves the current active/verified membership, project ancestry, environment protection and role bindings inside the caller's tenant transaction before evaluating that policy. Every resource query includes its organization, and environment queries include their parent project. Caller-supplied role or protection fields are ignored. Changed roles, protection and account status take effect on the next decision; no permission cache is used. Missing resources and denied permissions use the same resource-not-found response. The read-side module is independent of identity commands; session/bearer route wiring follows in M2.3d, with role mutations serialized against identity locks in M2.3c4.

An explicit environment role replaces the member's project role for that environment instead of adding to it, so a narrower environment binding can restrict access. Only an actor with project-level member management may create or remove an environment override for a member who administers the project, so an environment-only administrator cannot restrict a project administrator.

Organization admins may manage non-owner memberships, but only owners may grant or remove ownership. Removing or demoting the last owner is forbidden. Commands must lock the organization before reading the owner count and changing membership; the pure policy alone provides no concurrency guarantee. Project/environment administrators may only manage bindings within their authorized scope, never organization membership or ownership. Destructive-action authorization remains separate from the single-use confirmation required by M2.5.

Organization membership commands add existing active verified accounts by email; invitations to unknown/unverified accounts are not implemented. They recheck the directory candidate's email and state under ordered account locks, then lock the organization and repeat live member-management authorization. Existing memberships require an explicit role change when the requested role differs. Same-role requests are idempotent; removal cascades resource bindings. Only owners may manage owners, and simultaneous owner departures cannot remove the final owner (`last_organization_owner`). Disabled accounts may be removed but cannot receive a new membership/role. Membership writes, their audits and affected-account credential invalidation commit together.

Resource role assignment resolves an exact existing organization member by email only after the actor is authorized to manage that project/environment. It cannot add organization membership or grant organization ownership. New/changed bindings require an active verified account with the organization `member` role; existing bindings can still be removed after promotion or disabling. Project administrators manage their project and authorized environments; environment-only administrators manage only that environment. Explicit environment downgrades also constrain role administration, so a downgraded member cannot remove their own restriction. Removing an override may restore an inherited role and therefore invalidates credentials just like an assignment. Same-role or already-absent binding requests preserve credential versions while auditing proof confirmation.

Directory lookups never answer before the actor's password is checked: an unknown address and a wrong password give the same authentication failure, so membership and role commands cannot be used to discover which accounts exist or belong to an organization. An administrator of a single environment may not create or remove an environment override for a member who administers the whole project; only a project-level administrator (or an organization owner/admin) can, because the project admin could otherwise not undo the restriction.

The organization membership directory requires organization-level member management. Resource administrators can list authority only for their authorized project/environment: organization owners/admins plus members with applicable grants, including disabled members for cleanup. Each row separates the effective resource role/source (`organization`, `project` or `environment`), direct binding and inherited project binding. Membership metadata includes email and active state but no credentials. One SQL snapshot resolves bindings before pagination, preventing inconsistent parent/override reads during concurrent grant changes. These administration lists share the catalog's bounded exclusive UUID pagination.

Resource commands use the public `AccountMutationAuthority` identity boundary to recheck the active verified account and security version under its mutation lock. Operations that grant/change roles can require password and configured MFA proof; proof consumption, resource writes, audit and session rotation share the caller's transaction. Rotation through this boundary is available only within the same reauthenticated callback and for its account/version. A password reset racing password verification invalidates the mutation before it runs. Transport authentication supplies the actor context; request-body account ids are never trusted as the caller.

Privilege changes acquire the actor and affected account locks in canonical UUID order before any organization lock. Commands must not enter that boundary with an actor lock already held; preliminary resource authorization/directory lookup is read-only and repeated under the ordered locks. Fresh password/MFA proof is required. A changed role increments the affected account's security version, invalidating its sessions and API tokens atomically with the role/audit writes. Self-changes return a rotated session; changes to another account preserve the administrator's session. Idempotent no-ops do not rotate credentials but audit confirmation because a configured MFA proof may have been consumed. Proof expires when its callback ends, including for inherited detached asynchronous work. The internal verified-account directory returns only account id/email/active status and is available to authorized membership commands, never as an unauthenticated search endpoint.

Creating an organization requires fresh password and configured MFA proof. The organization, initial owner membership, ownership audit and security-version/session rotation commit atomically. The caller receives the new session; existing sessions and version-bound API tokens lose authority. Organization settings changes require live owner/admin authority under the caller's account lock. Globally occupied slugs return only `organization_slug_unavailable`, including concurrent creation/rename conflicts; tenant metadata and database diagnostics are never returned. Resource deletion is not exposed by these commands.

Project and environment creation/settings commands recheck live scope permissions under the account lock and commit their settings and audit together. Project slugs are unique per organization; environment names are unique per project. Collisions return fixed `project_name_unavailable` or `environment_name_unavailable` errors. Settings updates replace the supported settings as a whole; creation and replacement use the same validated defaults. Organization/project ownership comes only from the authorized resource path and cannot be changed through settings. Environment-only administrators cannot change their parent project or create sibling environments.

Resource catalogs require the current verified account/security version. Organization discovery uses the account-scoped SELECT policies; project and environment catalogs use tenant scope and apply live membership/binding filters in SQL before pagination. Owners/admins see their organization's resources; other members see only granted projects/environments, including parent navigation for environment-only grants. Lists use descending UUID order, an exclusive cursor and 1–100 items (100 by default); a full terminal page may return a cursor followed by an empty page. Cursors are range bounds, never cross-tenant existence lookups. Detail queries use the same live ancestry/permission checks and uniform missing-resource response.

Administration directories use session-only `GET /organizations/{organizationId}/members` and nested project/environment `/bindings` paths. Each requires `member.manage` at its exact scope; bearer credentials are rejected. Responses contain public membership metadata and, for bindings, effective/direct/inherited roles. The shared exclusive UUID pagination is validated at the HTTP boundary; filters are applied before pagination. Disabled members remain visible for authorized cleanup.

Membership writes are session-only and require Origin/CSRF, the current password and the configured second factor; bearer credentials are rejected even with `member.manage`. `POST /organizations/{organizationId}/members` (201) adds an existing active verified account by email with an organization role. `POST /organizations/{organizationId}/members/{membershipId}/role` (200) changes the role, and `POST .../members/{membershipId}/remove` (200) removes the membership and its resource bindings. Each answers `{ membership, session? }`, where `membership` is null after removal. `session` appears only when the caller changed their own role; the rotated credentials are then set only in cookies. Changing another account advances that account's security version, ending its sessions and tokens. An unknown address with a correct password answers 404, like a hidden resource. Encrypted retries cover these three routes, and every replay rechecks live `member.manage`.

Role-binding writes follow the same rules (session only, Origin/CSRF, password and configured second factor, `member.manage` at the exact scope). `POST /organizations/{organizationId}/projects/{projectId}/bindings` (200) assigns or changes a project role for an existing organization member, by email. The nested `/environments/{environmentId}/bindings` path does the same for an environment override. `POST .../bindings/{membershipId}/remove` (200) removes the binding at that exact scope. Each answers `{ binding, session? }`, with `binding` null after removal. Organization owners and admins, unknown addresses and non-members answer 404 with no write. An environment-only administrator cannot create or remove an override for a project administrator (SPEC 7). Assignments end the subject's sessions and tokens through their security version. Encrypted retries cover these four routes, and every replay rechecks live `member.manage`.

Token scopes use the closed permission vocabulary in `packages/domain/src/lib/api-token-policy.ts`: profile read, organization/project/environment reads and lifecycle capabilities, billing, members, nodes, deploy, secret write, container exec, volume/database deletion, observability and audit. No wildcard or secret-value-read permission exists. Each scope names a permission and UUIDv7 organization ID, optionally narrowed by project and environment IDs; environment bounds require their parent project. A token cannot span multiple organizations. `profile.read` is the only unscoped account permission. At most 32 input scopes are accepted, copied and deduplicated. Scope matching is never sufficient by itself: the owner's live RBAC policy must also allow the request. Token labels contain 1–64 Unicode code points without control/format characters; expiry is between one minute and ninety days, with at most 50 active tokens per user.

## 8. Public REST API

User-owned API token rows persist only a purpose-bound SHA-256 credential hash, scopes and lifecycle metadata. Password resets and MFA security changes invalidate tokens through the owner's security version; authentication also checks active account status, expiry and revocation. Last-use timestamps advance monotonically. Token lists are owner-filtered and use an exclusive UUID cursor, with at most 100 records per page. Live tenant authorization intersects token scopes with current membership, resource ancestry and environment protection on creation, authentication and private creation replay. Project ownership follows in M2.3e. The account command boundary can accept a transport-authenticated token only when the command supplies its own permission and target. It revalidates the exact token/owner, revocation, expiry, verified account and current authority while holding the account lock through the operation and audit transaction. A token revoked after HTTP authentication therefore cannot enter a subsequent command. Account-only and password/MFA privilege operations reject token contexts. Organization settings, project/environment creation/settings and individual resource reads opt in with command-owned permissions and targets. Their audit actor records the API token id rather than attributing the operation to a browser user. The authenticated transport preserves the credential as a redacted Secret for transactional revalidation. Catalog and membership/binding collections remain session-only: user-visible collection filters alone must not widen a token scope. Resource writes hold the credential owner lock through audit persistence, serializing concurrent revocation; an audit failure rolls back the resource and audit together.

Creating or revoking a token requires password reauthentication and the active MFA factor. Commands recheck the current security version under the user lock; token writes, proof consumption and audit events commit together. Repeating a completed revocation is harmless. Creation verifies every scope against live owner authority and serializes the active-token cap. Listing returns lifecycle metadata without hashes or security versions. A token's plaintext is returned only by creation (or its bounded encrypted idempotent replay).

A token can be bound to one project with `project: { organizationId, projectId }` at creation. Every scope must then stay inside that project or its environments; account-wide and organization-wide permissions are refused. The creator also needs live `member.manage` on the project. The creator remains the owner whose current authority and security version bound every use. Each authentication additionally refuses any target outside the bound project. The composite foreign key deletes the token with its project. Project administrators (`member.manage` on the project) list a project's tokens with `GET /organizations/{organizationId}/projects/{projectId}/api-tokens`, which returns metadata and the creator, never the secret. They revoke any of them with `POST .../api-tokens/{id}/revoke` (204), which requires a session, Origin/CSRF, the password and the configured second factor. Revocation holds the caller's and the creator's account locks in canonical order, so it serializes with the creator's bearer authentication. It changes neither account's security version and is audited with the project's organization. Both routes are session-only.

Bearer authentication re-reads the credential under the owner's lock before intersecting its scopes with current owner authority. Revocation and role/security changes use that same lock. API traffic has separate fixed one-minute quotas: 300 requests per token and 600 per trusted client IP, shared across instances, without the progressive delay used for password proofs. Invalid credentials still consume the IP budget. Creation retries must revalidate the cached credential and owner authority before disclosing it again.

Bearer status codes: a missing, malformed, revoked or expired token, and any valid token on a route that does not accept tokens, gets 401 `authentication_failed`. A valid token whose scopes do not cover the route's exact permission and target gets 403 `api_token_permission_denied`; this check runs before any resource lookup, so missing and hidden resources answer the same way and nothing leaks. Sessions keep the uniform 404 `resource_not_found` for missing or unauthorized tenant resources.

Every controller route must explicitly declare anonymous, account or tenant access; undeclared routes reject even valid credentials. Account declarations cannot authorize routes carrying organization/project/environment parameters. Tenant routes resolve canonical UUIDv7 ancestry exclusively from path parameters and check live resource permissions for sessions. Bearer opt-in must match the declared route permission and receives that same target; request bodies and query strings cannot change authority. A route inventory test checks declarations on every registered controller. Resource HTTP endpoints and route/role acceptance follow in M2.3d3–d4.

[`docs/generated/route-role-matrix.md`](generated/route-role-matrix.md) lists every registered route with its access declaration, its bearer permission and the decision for each fixture role. A unit test regenerates it and fails on any difference. It also checks each `permission@scope` against an independent copy of the section 7 table. An integration test replays every tenant route for every role through the real guards: an allowed read answers 200, an allowed write with an empty body answers 400, and a denial answers 404.

Resource creation/settings retries reuse the five-minute encrypted request/result store through the exported identity HTTP interceptor. Its route allowlist contains only explicit organization/project/environment creation/settings paths; deletion and unrelated paths are rejected. Fingerprints bind the request body, account/security version, credential kind and API-token id. Cached resource results recheck current account, exact credential and live route permission after any storage wait. This check runs only on replay, preserving ordered actor/subject locking inside privilege-changing commands. Resource writes, audits and encrypted retry persistence share one transaction; a storage failure returns no result or session cookie.

Organization writes use `POST /organizations` (201) with name, slug, password and configured MFA proof, and `POST /organizations/{organizationId}/settings` (200) with name/slug. Creation requires a session, returns organization plus public session metadata, and sets rotated credentials only through cookies. Settings accepts the scoped `organization.update` bearer permission or an authorized session. Session writes require Origin/CSRF. Both accept encrypted retries; an old credential cannot replay a creation after ownership rotates the account version, and a different version conflicts with the prior retry fingerprint. The web client must accept the returned session profile and recover lost creation responses through authenticated organization discovery.

Project/environment writes use `POST` on the nested project/environment collection (201) and on each resource's `/settings` path (200). Each accepts authorized sessions or its exact scoped bearer permission: `project.create`, `project.update`, `environment.create` or `environment.update`. Session requests require Origin/CSRF; encrypted retries preserve the original result and audit once. Bodies contain only supported settings; ownership comes from the path. Omitted options use the domain defaults, while nulls, unknown fields and coercible strings are rejected. Settings are complete replacements, including defaulted options.

Resource reads use `GET /organizations`, `/organizations/{organizationId}`, `/organizations/{organizationId}/projects`, `/organizations/{organizationId}/projects/{projectId}`, and the nested `/environments` collection or `/{environmentId}` detail. Collections require a session and accept `cursor`/`limit` (1–100); detail routes additionally accept the matching scoped bearer permission. Unknown collection query fields and malformed pagination are rejected. Metadata includes ISO timestamps and explicit settings, never memberships or credentials. API quotas apply to session reads and are consumed only once for bearer requests already throttled by authentication.

HTTP routes deny bearer access unless explicitly opted in. `GET /auth/session` accepts `profile.read` and returns account metadata with the API credential's expiry; it creates no browser session. MFA and credential-management routes require a browser session. Authorization headers never fall back to cookies; duplicate or malformed headers fail closed. Origin/CSRF checks apply to session mutations and anonymous browser mutations. Explicitly permitted bearer requests use their non-ambient header credential and do not require browser CSRF proof.

Session-only token management uses `POST /api-tokens` (201, secret plus metadata), `GET /api-tokens?cursor=&limit=` (items plus nextCursor, default/max 100), and `POST /api-tokens/{id}/revoke` (204). Creation/revocation require password and optional TOTP/recovery proof when MFA is enabled, Origin and session-bound CSRF; both accept encrypted idempotent retries. A full page returns an exclusive cursor; an exhausted cursor may yield an empty terminal page. Dates require an explicit timezone. A revoked, expired, invalidated or no-longer-authorized token cannot be retrieved from a prior creation retry.

The browser identity transport uses the generated SDK against the current origin only, with same-origin cookies, no response caching and no redirects. Requests time out after twenty seconds and preserve caller cancellation. It reads exactly one matching CSRF cookie (the `__Host-` variant on HTTPS), supplies caller-owned idempotency keys for mutations and never sets bearer credentials. Browser session state retains only user ID, email and expiry in memory. It discards late responses after newer state changes and distinguishes unauthenticated access from temporary service failure. UI errors use fixed messages and bounded retry delays rather than forwarding arbitrary server/transport diagnostics.

Form submissions suppress concurrent requests and retain their retry key for an unchanged body after uncertain transport/server failures. They require an explicit restart after four minutes (before the server's five-minute cache expires), a backward clock change or a replay conflict. Known client rejections release the attempt; HTTP 408 remains uncertain, and HTTP 429 preserves the key because a throttled retry may follow an already-committed command. A bounded server-requested wait survives a form restart. Private retry snapshots live only in native private fields for the form's lifetime, are cleared after success/restart/destruction and cannot appear in object serialization. Leaving or resetting a form invalidates its pending results.

Account forms cover signup, verification, verification resend, login and both password-reset steps. Only active fields participate in validation. Passwords retain whitespace and Unicode code points; new passwords require confirmation. Email and pasted code edges are trimmed, while login accepts either an optional authenticator code or one recovery code. Codes are never read from or written to navigation URLs. Mail-request outcomes remain generic. Successful submissions and route departure clear passwords/codes; abandoned login results cannot populate browser session state.

Web routes are `/auth/login`, `/auth/register`, `/auth/verify-email`, `/auth/request-verification`, `/auth/forgot-password` and `/auth/reset-password`. Public email links `/verify-email` and `/reset-password` redirect to their matching forms. Successful login opens `/account/security`; sign-out returns to login only after server confirmation. Forms use associated labels/help/errors, an error summary, keyboard focus on route/results, optional native MFA disclosure and a content skip link. Navigation moves above the working column on narrow screens. Tailwind and Angular CDK provide the shared styles and programmatic focus primitive, following ADR 0009.

MFA forms distinguish unknown/unavailable status from disabled protection and require current password/proof for the chosen operation. Account security mutations share one submission gate, including sign-out, to avoid overlapping rotations. Provisioning seeds are hidden at their server expiry (with a ten-minute client cap); recovery codes, shown only once by the server, stay visible until acknowledgement or page departure (no timer, WCAG 2.2.1). Successful rotation updates only public session fields. Private grants and inputs clear on dismissal/destruction and serialize as an opaque store label. A setup display timeout hides the seed but preserves a running activation's confirmed recovery-code result.

The account MFA panel supports manual authenticator enrollment with a copyable setup key (time-based, six digits, 30 seconds), activation, recovery-code replacement and disable. Provisioning URIs are not rendered as navigation links. Private text is copied only on an explicit user gesture through the browser clipboard API; denied/unavailable clipboard access offers manual selection and never exposes raw diagnostics. Recovery codes disappear on acknowledgement or timeout. Security-change forms explain session/API-token invalidation before submission, and one shared error summary receives focus when a request fails.

Browser token management retains one metadata page at a time with forward/back cursors, and requires known MFA status before allowing mutations. Creation currently grants only `profile.read`; tenant permission selection follows the live policy adapter in M2.3. The user chooses 1, 7, 30 or 90 days; the absolute expiry is fixed when starting/changing the form, so an uncertain retry preserves the same body/key. Private credentials disappear on acknowledgement, departure or session rotation; no timer hides a token the server shows only once (WCAG 2.2.1). This hides the display without revoking the saved token. Creation/revocation refresh the first metadata page after confirmation. HTTP conflicts use a generic state-conflict message because the same status also covers capacity/state constraints, not only retry-cache conflicts.

The token panel shows permissions, creation/use dates, expiry and status in a keyboard-scrollable table. It keeps the creation credential separate from metadata and requires an explicit copy or acknowledgement action. Session changes clear private token state and refresh metadata, including MFA-driven token invalidation. Expired status updates locally at a thirty-second cadence; revoked, expired and invalidated rows cannot offer an active-token revocation action. Background session/MFA/token loading is registered with Angular pending-task tracking; mutation progress labels belong to the operation that is actually running.

In production, the API serves `dist/apps/web/browser` (override with `WEB_DIST_DIR`) on the browser's public origin. Before listening, it snapshots only index HTML and allow-listed JS/CSS/image/font assets: at most 1,024 directory entries, 16 directory levels, 8 MiB per file and 32 MiB total. Symlinks, missing nonce markers and invalid builds fail startup with opaque diagnostics. Requests never resolve filesystem paths. Dotfiles, maps, JSON metadata, traversal paths and the entire `/api` namespace cannot enter the SPA fallback; only GET/HEAD HTML navigation may use it. Hashed Angular bundles receive immutable caching, other public assets five minutes, and HTML remains `no-store` with a new 192-bit nonce on every response. CSP permits same-origin scripts/connections, nonce-bound component styles and Angular's reviewed Trusted Types policies; inline scripts/styles are disabled in the production build. This follows [Angular's CSP and Trusted Types guidance](https://angular.dev/best-practices/security). The development proxy requires `API_PUBLIC_URL` to match the web origin (normally port 4200), preserving the same Origin/CSRF boundary.

- Base path `/api/v1`. OpenAPI 3.1 generated from NestJS decorators and published at `/api/v1/openapi.json`.
- Auth: session cookie (UI, `SameSite=Strict`, CSRF token) or `Authorization: Bearer <api_token>`.
- Errors: RFC 9457 problem details with a stable `type` URI per error.
- Pagination: cursor based (`?cursor=&limit=`, max 100).
- Idempotency: `Idempotency-Key` header supported on all POST endpoints.
- Identity retries use lowercase UUIDv4/v7 keys, scoped to the endpoint, for five minutes. The original body and credential context must match. A PostgreSQL transaction lock serializes the same key across instances; command, audit and retry snapshot commit together. Request/response snapshots are envelope-encrypted (including passwords, codes and session cookies), never stored as plaintext or an offline password-verification hash. This short-lived snapshot is the exception to hash-only credential persistence; it is operational retry state, not a second authentication authority. Expired snapshots are removed in bounded batches, and a failed command creates no reusable result.
- `Idempotency-Replayed` distinguishes a cached success from the first execution. Origin checks and rate limits still apply on retries. Anonymous account actions bind the body; logout additionally binds session, CSRF and authorization headers before returning an already committed result. Replayed login verifies that the cached session remains active; logout, password reset, expiry or privilege changes make it return 409 without cookies. Snapshots expire logically after five minutes; physical cleanup happens in bounded batches on successful new commands. A client must use a new key after expiry or a changed request.
- Rate limits per token and per IP, returned in `RateLimit-*` headers.
- Resources: `/organizations`, `/projects`, `/environments`, `/nodes`, `/join-tokens`, `/applications`, `/applications/{id}/deployments`, `/deployments/{id}` (+ `/cancel`, `/rollback`), `/releases`, `/domains`, `/secrets` (write and list names only), `/databases`, `/volumes`, `/backups`, `/backup-targets`, `/previews`, `/alert-rules`, `/notification-channels`, `/audit-events`, `/api-tokens`, `/confirmations` (issue confirmation tokens), `/imports/coolify`.
- Live updates: `GET …/environments/{environmentId}/events` (SSE, `environment.read`, PLAN M2.6b).
  - Each committed audit event of the environment produces a `change` event with its type, target, application and time, never its metadata: clients reload through the normal API.
  - It follows `audit_events`, not the in-process bus, which publishes before commit and could announce a rolled-back change.
  - The session and permission are rechecked on every poll (2 s), so revocation ends the stream. Streams last at most one hour and eight per account; browsers reconnect, resuming with `Last-Event-ID`.
  - A request without `Accept: text/event-stream` answers 406.
  - Clients keep a slow fallback poll, because a transaction committing late can carry an older id than the stream's cursor. Organization-wide events are not streamed.
- Body limits: JSON and form bodies are capped at 16 KiB, except JSON `POST`s to `…/environments/{environmentId}/secrets`, `…/applications` and `…/applications/{applicationId}/config`, capped at 256 KiB because secret values and configurations are larger. The domain limits (64 KiB) still apply.
- Applications (PLAN M3.4b1), under `…/environments/{environmentId}/applications`:
  - `POST` with `{config}` creates an application from a `shipkeep.yml` document sent as JSON (201). It needs `deploy.run`, so developers may do it only on unprotected environments (SPEC 7), because the configuration takes effect at the next deployment.
  - `GET` lists the environment's applications, and `GET …/{applicationId}` reads one (`environment.read`).
  - `POST …/{applicationId}/config` with `{expectedConfigSha, config}` replaces the configuration if it still has that hash, otherwise 409 `application_config_changed`. The name cannot change. Saving an identical configuration records nothing.
  - The web editor validates YAML locally and shows a diff before saving. On 409 it retains the draft, loads the latest version on request, and requires another review before retrying with the new hash. Drafts live only in the component; saving does not start a deployment.
  - Rules:
    - documents are validated against the schema, and errors list JSON pointers and schema messages without input values;
    - only `build.type: image` is accepted until git (M3.1) and Compose (M3.8) sources;
    - the canonical JSON (sorted keys) is limited to 64 KiB and hashed with SHA-256 into `configSha`;
    - a duplicate name in the environment is 409 `application_name_taken`;
    - a hostname belongs to one application per organization: saving a configuration syncs its `domains`, and a host another application claims is 409 `domain_taken` (a rollback checks this too);
    - wildcard domains are refused with 400 `wildcard_domain_unsupported` until DNS-01 exists.
  - `GET …/{applicationId}/domains` (`environment.read`) looks up each domain live: `public` with its addresses, `private` (only non-public answers, never revealed, so the control plane's resolver cannot be used to map internal names), `none` or `unknown`. It does not connect to the answers. Comparing them with the node's public address is left to the operator until nodes report one.
  - `application.created` and `application.updated` audit events carry the name, source and configuration hashes, not the configuration.
- Deployments (PLAN M3.4b2), under `…/applications/{applicationId}`:
  - `POST …/deployments` (201, `deploy.run`) snapshots the configuration as the next release (numbered per application) and queues a deployment.
    - The plan skips `building` and `built` for image sources, and runs `releasing` only when `release.command` is set.
    - It is refused with 409 `secrets_missing` (listing the names) while a referenced secret is unset, and with 409 `deployment_in_progress` while another deployment is unfinished.
  - `GET …/replicas` (`environment.read`) lists the placed replicas with their node, container and what the agent last saw (`state`, null until seen; `observedAt`).
  - `GET …/deployments` lists the 50 most recent deployments; `GET …/deployments/{deploymentId}` reads one; `GET …/releases` lists the 50 most recent releases (`environment.read`).
  - `POST …/deployments/{deploymentId}/cancel` (`deploy.run`) cancels an unfinished deployment through the aggregate. The pipeline (M3.4c) acts on the reported routing outcome.
  - `POST …/deployments/{deploymentId}/rollback` (201, `deploy.run`) deploys a new release copying the pinned image and configuration of the release that deployment ran.
    - The target must have succeeded (or been rolled back) and must not be the release serving now; otherwise 409 `rollback_target_invalid` or `release_already_serving`. A release that never resolved its image answers 409 `release_not_deployable`.
    - The release command does not run again, because migrations of an older version must not be replayed over newer data. Secrets use their current values, and the application's own configuration does not change, so the next deployment uses it again.
    - When the rollback succeeds, the deployment it replaced becomes `rolled_back`, audited as `deployment.rolled_back`.
  - Database guarantees:
    - a partial unique index keeps one unfinished deployment per application;
    - releases are immutable: a trigger and the runtime grants allow only recording the image digest, once;
    - finished states and `finished_at` go together (CHECK).
  - Audit events: `release.created`, `deployment.queued` and `deployment.cancelled`.
- Image resolution (ADR 0012, PLAN M3.4c2): agents pull only by digest, so the pipeline resolves a release's tag before anything reaches a node. The digest is recorded once on the release.
  - Docker rules name the registry (Docker Hub is `registry-1.docker.io`, with `library/` for single-name images) and `latest` is the default tag. A reference that already carries a digest is used as is, without any request.
  - The control plane sends a `HEAD` for the manifest with the index and manifest media types. On 401 it fetches an anonymous token from the `Bearer` realm, scoped to `repository:<name>:pull`. When the `Docker-Content-Digest` header is missing, it hashes the manifest as served.
  - SSRF guards on every request:
    - HTTPS only, no credentials in URLs, no redirects;
    - IP literals and every resolved address must be public: not loopback, private, link-local, CGNAT, multicast, reserved or documentation ranges, including IPv4-mapped and NAT64 forms;
    - the socket connects to the address that was checked;
    - a 10 s timeout and 1 MiB responses at most.
  - Failures report `image_resolution_failed` with the registry and the status, never tokens. Private images and registries on private networks are not supported yet (open question).

### 8.1 Identity security parameters

- Account endpoints are `POST /auth/register`, `/auth/verification/request`, `/auth/verify`, `/auth/reset/request`, `/auth/reset`, `/auth/login`, `/auth/logout` and `GET /auth/session`, under `/api/v1`. Signup and mail requests return an empty 202 regardless of account existence/status. Codes are submitted in JSON bodies. Without SMTP configuration, mail requests fail with 503 before account creation. Anonymous browser mutations require the exact `API_PUBLIC_URL` Origin; session mutations also require `X-Shipkeep-CSRF` matching the CSRF cookie. All responses use `Cache-Control: no-store`; JSON/form bodies are capped at 16 KiB (larger only on the secret and application writes of section 8). `TRUST_PROXY=none` is the default; `loopback` is available only when the local reverse proxy overwrites forwarding headers and the API is not exposed through another proxy.
- Account pre-hijacking defence: `POST /auth/verify` takes the verification code and the password chosen at registration. The code proves the mailbox; the password proves the person verifying is the one who registered, so nobody can register someone else's address and wait for the owner to activate it. Password reset works on pending accounts as well as active ones and activates a pending account: the mailbox owner can always claim an address someone else registered first, which also invalidates the earlier password, links and sessions.
- Email identities use lowercase ASCII mailboxes (maximum 254 characters, local part 64); PostgreSQL `citext` enforces case-insensitive uniqueness. Internationalized and quoted mailboxes are outside v0.1.
- Passwords contain 15 to 128 Unicode code points, without trimming, normalization or composition requirements. NUL is rejected. Argon2id v19 uses 64 MiB, three iterations, one lane, a random 16-byte salt and a 32-byte hash. At most two hashes run concurrently per process, with at most 16 waiting callers; overload fails closed.
- Session, verification, reset and API credentials have 256 random bits. Only SHA-256 hashes with a distinct `shipkeep:<purpose>:` prefix are persisted. Email verification expires after 24 hours; password reset after 30 minutes. Session limits remain 12 hours idle and seven days absolute, with equality at either boundary considered expired.
- TOTP uses RFC 6238 SHA-1, a random 160-bit secret, six digits and a 30-second period. Accept the current time step and one adjacent step in either direction. Persist the accepted counter atomically and reject counters already consumed. Ten random 128-bit recovery codes are shown once and stored as purpose-bound hashes; each is consumed atomically.
- Pending TOTP enrollment expires after ten minutes and is tied to the account security version; a password reset invalidates it. The database stores either a pending or active encrypted seed, never both. Activation requires an active account and a current pending version. Disabling MFA removes its recovery hashes; counter and recovery claims join the user's audited transaction so a failed command cannot consume a proof.
- MFA setup and activation require current-password reauthentication; disabling MFA and replacing recovery codes additionally require a fresh TOTP or unused recovery code. Activation, disablement and recovery replacement increment the security version, revoke all older sessions/reset links and return a fresh session atomically. Login grants no session until the active second factor succeeds. Password reset preserves MFA and its recovery mechanism. Recovery use and all MFA management commands are audited without secret values.
- MFA HTTP routes are `GET /auth/mfa` and `POST /auth/mfa/setup`, `/enable`, `/disable`, `/recovery`. Status returns only enabled/pending state and the remaining-code count. Setup returns private provisioning data; activation/recovery replacement return ten private codes, always with no-store headers. Login accepts either `totp` (six digits) or `recovery` (32 lowercase hex characters). MFA mutation limits use the authenticated user ID as well as IP; changing IP does not reset the account limit. Authenticated retry snapshots bind user ID and security version. After credential rotation, retries with a different security context conflict; a user who loses the recovery-code response can sign in with TOTP and regenerate codes after reauthentication.
- TOTP provisioning URIs are secret response data, never navigation URLs or log fields. Secret values stay wrapped until hashing, encryption or an explicitly defined delivery boundary.
- Identity email requires SMTP with implicit TLS (normally port 465), certificate-chain and hostname verification, and TLS 1.2 or newer. Configure `SMTP_HOST` and `SMTP_FROM`, optionally paired `SMTP_USER`/`SMTP_PASSWORD` and a public `SMTP_CA_FILE` for a private issuer. STARTTLS/plaintext SMTP is not supported in v0.1. Delivery has a ten-second inactivity timeout and a twenty-second total deadline. Emails contain a clean page link and a code to paste; the bearer credential is never embedded in a navigation URL. `API_PUBLIC_URL` is an origin without credentials/query/fragment and must use HTTPS in production.
- Authentication limits are persisted in PostgreSQL per operation, on three axes: client network (an IPv4 address or an IPv6 /64), subject, and subject from one client network. Credential operations allow 100 requests per network and ten per subject and network in 15 minutes; the subject alone has no hard cap, so failures from elsewhere can never lock its owner out, but every credential attempt on a subject is spaced by 250 ms doubling up to 8 seconds (up to 64 seconds per subject and network). Signup and email requests allow 20 per network and five per subject per hour; that per-subject cap is kept on purpose to prevent mailbox flooding. Rejected retries do not extend a block. Successful login clears its account delay and that network's account quota, never the network quota. Expired buckets are removed in bounded batches. The HTTP layer returns the applicable quota and retry delay; it must normalize subjects and derive IPs from explicitly trusted proxy configuration.

## 9. Secrets

- Envelope encryption. A key-encryption key (KEK) lives in `/etc/shipkeep/kek` (0400, owned by the service user; 32 raw bytes or their base64) or an external KMS later. Each environment has a data-encryption key (DEK) stored encrypted by the KEK (`DataEncryptionKey`, scope `environment:<id>`). Values are encrypted with AES-256-GCM using the DEK, with associated data that binds the ciphertext to its scope and purpose (`shipkeep:data:<scope>:<purpose>`); blob layout `0x01 | nonce(12) | tag(16) | ciphertext`. The API refuses to start when the KEK file is readable by group or others.
- Secrets are sent to agents only inside `CreateContainer` and `RunReleaseTask`, over mTLS, and passed to containers as environment variables (default) or as files on a tmpfs mount (`secrets_as_files: true`).
- The agent never writes secret values to its SQLite database or its own files; the journal stores a hash of the payload and `desired` stores secret references only.
- Known limitation, documented for users: Docker itself persists a container's environment variables in its container configuration on disk (readable by root only). This is what lets Docker restart a container after a crash or a reboot without the control plane. With `secrets_as_files: true` nothing is persisted, but after a node reboot those containers can only start once the agent has fetched the values from the control plane again.
- The API never returns secret values after creation. The UI shows names, versions and who changed them.
- HTTP:
  - `GET …/environments/{environmentId}/secrets` lists names, versions, author and dates (`environment.read`).
  - `POST …/secrets` with `{name, value}` creates version 1 or stores the next version (`secret.write`).
  - `POST …/secrets/{name}/remove` removes a secret (204).
  - All three accept sessions or scoped tokens, and writes have no encrypted retry.
- Rules:
  - names match `^[A-Z_][A-Z0-9_]{0,127}$`, and values are 1 byte to 64 KiB without NUL;
  - developers may write only unprotected environments (SPEC 7);
  - each value is encrypted with the environment DEK and bound to its name and version;
  - concurrent writers are serialized by a version compare-and-swap;
  - `secret.set` and `secret.removed` audit events carry the name and version only.
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

- Installation-level audit access: system and account events (`organization_id` null, for example `fleet.installation_key.created`) are not readable by the runtime role. Proposal for M2.4a: an installation-administrator capability, held by the first owner and audited, with its own read context.

- Retry-safe certificate renewal after a response is lost: a recovery protocol must preserve the one-active-certificate invariant without accepting a revoked identity.

- Agent action history (issue #263): actions queued before the migration that links actions to deployments stay unlinked, because no released version has such actions to backfill. The agent sends the same `action deadline exceeded` text when it refuses an overdue request and when an action times out while running, so both are reported as `failed`; a distinct refusal text in the agent would let the history show the first as `refused`.

- Private registries: credentials for private images, and an explicit allow-list for registries on private networks (the resolver refuses non-public addresses by default, SSRF).
- Corrosion adoption for peer-to-peer routing replication (target v0.5).
- Wildcard certificates: which DNS providers to support first for DNS-01 (proposal: Cloudflare, Route 53, Hetzner DNS, OVH).

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
