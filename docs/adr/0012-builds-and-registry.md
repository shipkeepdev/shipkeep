# ADR 0012: Rootless BuildKit builds and an internal registry

- Status: Accepted
- Date: 2026-11-03

## Context

Builds run user-controlled code (Dockerfiles, build scripts). In Coolify, build context escapes led to host-level command execution.

## Decision

- Builds run in rootless BuildKit (`buildkitd` rootless mode) on nodes labeled `builder` (by default the control plane node).
- `buildkitd` runs as a dedicated user `shipkeep-build` that is **not** in the `docker` group and has no access to the Docker socket. The agent talks to it over its socket (group-readable by `shipkeep`). A build escape therefore lands in an unprivileged user, not in a root-equivalent one.
- Host requirements set up by the installer: cgroup v2 with delegation for `shipkeep-build` (needed for per-build CPU and memory limits), subordinate UID/GID ranges, and on Ubuntu 24.04 an AppArmor profile allowing unprivileged user namespaces for `rootlesskit`.
- Supported build types: `dockerfile`, `railpack`, `nixpacks`, `image` (no build).
- Built images are pushed to an internal OCI registry (CNCF Distribution) reachable only over the WireGuard network, authenticated with short-lived tokens issued by the control plane. Until WireGuard lands (task M4.1), the registry listens on the control plane node's loopback only, which is enough for single-node deployments.
- External images (`build.type: image`, Compose services, managed databases) are pulled from their own registries, always by digest. The control plane resolves tags to digests when it creates a release.
- The last N images per app (default 5) are kept for rollback.
- Build resource limits (CPU, memory, time, disk) are enforced per build.

## Consequences

- A malicious build cannot reach the host Docker socket or the host filesystem.
- Rollback never depends on an external registry.
