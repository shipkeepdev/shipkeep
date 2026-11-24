# ADR 0030: Builds and the registry without a private network

- Status: Accepted
- Date: 2026-11-24
- Amends: ADR 0012

## Context

ADR 0012 builds images in rootless BuildKit on `builder` nodes, by default the control plane's node. It pushes them to a CNCF Distribution registry that only the WireGuard network reaches, and that listens on loopback until WireGuard lands (M4.1). The first stable version leaves WireGuard out, and two of ADR 0012's assumptions no longer hold:

- **There is no private network.** A registry on loopback serves only its own machine. The egress guard of ADR 0023 also keeps the Docker daemon off loopback, even there.
- **The control plane's machine is not a builder.** On a separate machine, its agent has the control-plane-only role and runs no workload (ADR 0028). On one machine, a build would run beside the key-encryption key and the database.

## Decision

The maintainer chose these on 2026-11-24.

### Where builds run

A build runs on the server where the deployment places the application's first replica, so it has the same trust as the application itself. On one machine (ADR 0021), that is the machine. A control-plane-only machine never builds. `builder` labels stay for a later version.

### How a build runs

ADR 0012 holds for BuildKit:

- rootless `buildkitd` runs as `shipkeep-build`, which is not in the `docker` group and cannot reach the Docker socket;
- the agent drives it through its gRPC socket, with typed requests and never a shell;
- limits apply per build;
- the installer sets up cgroup delegation, subordinate ID ranges and the AppArmor profile.

What changes is the network: builds get the egress guard of ADR 0023, applied to `shipkeep-build`'s cgroup. `RUN` steps reach public addresses, so they can fetch dependencies, and never loopback, private ranges or link-local addresses, cloud metadata included.

### Build types

The three of ADR 0012:

- **`dockerfile`**: BuildKit's own frontend.
- **`railpack`**: Railpack (MIT) writes its plan in a container, and BuildKit builds it with Railpack's frontend image.
- **`nixpacks`**: Nixpacks (MIT) writes its Dockerfile in a container, and BuildKit builds it.

Their images are pinned by digest in the agent, never on the host, so the agent still executes nothing on the host (CLAUDE.md rule 3).

### The source

BuildKit fetches the repository itself, at the commit, over HTTPS. The installation token of the Git provider (ADR 0031) is a BuildKit secret. It is minted for the action, travels inside it, encrypted as SPEC 3.3 says, and is never written to disk.

### The registry

CNCF Distribution (Apache-2.0) runs as a service of the control plane's Compose project.

- **Where it is served.** On the control plane's public name, under `/v2/`. On a separate machine, the Compose Caddy routes it. On one machine, the agent's route for the control plane does (ADR 0021). Pulls and pushes go through the egress proxy like any public registry (ADR 0023).
- **Tokens.** Distribution's token authentication checks a JWT that the control plane signs with a key of its own. The control plane mints one per action:
  - `push` and `pull` on one application's repository, for the build;
  - `pull` only, for a server that deploys it.

  A token lasts 15 minutes and travels inside the encrypted action, as registry credentials do (ADR 0019). No token endpoint is published.

- **Images.**
  - Each application has its repository, `<control plane name>/<organization id>/<application id>`, tagged with its release number.
  - A release pins its image by digest, as any release does.
  - The last 5 images of each application are kept for rollback (ADR 0012). Older manifests are deleted, and the registry's garbage collection frees their space.
  - Rollback never depends on a registry outside the installation.
- **Data.** Images live in a volume of the control plane. They are not in the instance backup (ADR 0026): an image can be built again from its commit, while the database cannot.

### Output

The build's output goes through the log stream of ADR 0029, under the deployment's labels. The deployment page reads it there.

## Consequences

- Builds use the application server's CPU, memory and disk, within the build limits.
- The control plane's name must reach its own machine from every server, so on one machine it must reach itself. Behind a NAT that does not loop back, set the name in `/etc/hosts`, which `docs/INSTALL.md` will say.
- The registry holds every built image. Its volume grows with the applications, up to five images each.
- A server that cannot reach the control plane cannot pull a new image. Running workloads keep running, as they do with any other registry (CLAUDE.md rule 10).
- `actions.proto` is unchanged: `BuildImage` already has `push_credentials`, `git_token`, `build_type` and limits.

## Alternatives considered

- **An external registry the user configures.** Rollback would depend on it, against ADR 0012.
- **No registry, building on the target server.** It would be limited to one server per application.
- **Building on the control plane's machine**, as ADR 0012 first said. A build is the application's own code, and that machine holds the installation's keys.
