# ADR 0030: Builds and the registry without a private network

- Status: Accepted
- Date: 2026-11-24
- Amends: ADR 0012
- Amended: 2026-11-27, Railpack reads a copy of the repository (issue #215)

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

What changes is the network. ADR 0023's kernel rule only keeps loopback away, and its proxy only sees what goes through it, which `RUN` steps need not do. So `shipkeep-build`'s traffic gets a rule of its own, in the same nftables table, matched on its user:

- it reaches public addresses, on any port, plain HTTP included, so that `RUN` steps fetch dependencies (`apt-get` from `http://deb.debian.org`);
- it never reaches loopback, private and shared ranges (RFC 1918, `100.64.0.0/10`, `fc00::/7`), link-local addresses (cloud metadata included), multicast, nor the server's own addresses, so a build cannot reach a service the server binds on all its addresses;
- the one exception is the host's DNS resolver, on port 53, which slirp4netns forwards names to.

### Build types

The three of ADR 0012:

- **`dockerfile`**: BuildKit's own frontend.
- **`railpack`**: Railpack (MIT) writes its plan in a container, and BuildKit builds it with Railpack's frontend image. That frontend reads the repository and the plan only from directories the build's client serves, never from a source BuildKit fetched. So BuildKit fetches the repository and writes it, with the plan, to a directory of the agent's on the server (mode 0700, under its state directory); the agent serves both to the frontend through the build's session, without the Git token, and deletes them after the build. One build runs at a time on a server (ADR 0032), so a Railpack build first deletes whatever an interrupted one left. The build arguments are build secrets, as Railpack reads them: they are not in the image.
- **`nixpacks`**: Nixpacks (MIT) writes its Dockerfile in a container, without network, and BuildKit builds it over the repository with the Dockerfile frontend. Nixpacks writes no plan file: the build arguments it would pass to `docker build` are read from the script it writes beside its Dockerfile, keeping only environment variable names and never BuildKit's own (`BUILDKIT_…`). It declares the application's arguments in its Dockerfile, which also sets them in the image's environment.

Railpack's image and Nixpacks' release archive are pinned in the agent, by digest and by SHA-256, never on the host, so the agent still executes nothing on the host (CLAUDE.md rule 3). Their cache mounts are each application's own: a key derived from the application's repository in the registry.

### The source

BuildKit fetches the repository itself, at the commit, over HTTPS. The token of the Git provider (ADR 0031) is a BuildKit secret. It is minted for the action with read access to that one repository's contents and nothing else, travels inside the action, encrypted as SPEC 3.3 says, and is never written to disk. The agent serves it under a random secret name that only its own Git source step uses: a `RUN --mount=type=secret` in the Dockerfile cannot guess it. The control plane revokes the token when the build ends.

### The registry

CNCF Distribution (Apache-2.0) runs as a service of the control plane's Compose project.

- **Where it is served.** On the control plane's public name, under `/v2/`. On a separate machine, the Compose Caddy routes it. On one machine, the agent's route for the control plane does (ADR 0021). Pulls and pushes go through the egress proxy like any public registry (ADR 0023).
- **Credentials.** Distribution uses its token authentication: a request without a token gets `401` with a `Bearer realm`, the control plane's token endpoint. The Docker daemon and BuildKit call it with a user name and a password, then send the JWT it returns. So each action carries a user name and password, as `RegistryCredentials` already does (ADR 0019), and `actions.proto` does not change:
  - `push` and `pull` on one application's repository, for the build;
  - `pull` only on it, for a server that deploys it.

  The password is a random secret, stored hashed with its scope, and valid until the action's own deadline: the queue wait and the build timeout for a build, so a long build can still push. The endpoint answers a token of 5 minutes, for what was asked within that scope, signed with a key of the control plane's own. It is rate limited, and its answers never say why a credential was refused.

- **Images.**
  - Each application has its repository, `<control plane name>/<organization id>/<application id>`, tagged with its release number.
  - A release pins its image by digest, as any release does.
  - An image is kept while a release that a rollback can reach names it: the current release of each environment and the 5 successful ones before it (ADR 0012). A build whose deployment failed does not count. Other manifests are deleted.
  - Distribution's garbage collection only runs on a registry that does not write, so it runs at a quiet hour with the registry read-only. A push in that window fails, and so does the build that makes it; the next deployment builds again.
  - Rollback never depends on a registry outside the installation.
- **Data.** Images live in a volume of the control plane. They are not in the instance backup (ADR 0026): an image can be built again from its commit, while the database cannot.

### Output

The build's output goes through the log stream of ADR 0029, under the deployment's labels. The deployment page reads it there.

## Consequences

- Builds use the application server's CPU, memory and disk, within the build limits.
- The control plane's name must resolve to a public address that reaches its own machine from every server, so on one machine it must reach itself through that address. Behind a NAT that does not loop back, Git deployments do not work in this version: the egress proxy and the build rule refuse private addresses, and an exception would open the private network to every pull. `docs/INSTALL.md` will say so.
- The registry holds every built image a rollback can reach. Its volume grows with the applications, about six images each.
- A server that cannot reach the control plane cannot pull a new image. Running workloads keep running, as they do with any other registry (CLAUDE.md rule 10).
- A Railpack build uses the server's disk for a copy of the repository while it runs, outside BuildKit's own bounds.
- `actions.proto` is unchanged: `BuildImage` already has `push_credentials`, `git_token`, `build_type` and limits, and `PullImage` has its credentials.
- The control plane publishes one more endpoint, the registry's token endpoint, which takes only action credentials.

## Alternatives considered

- **Railpack's Go module inside the agent**, which would turn the plan into BuildKit operations over the source BuildKit fetched, with no copy on disk. It adds a large set of dependencies to the agent, and reads a plan the repository shapes in the process that talks to Docker.

- **An external registry the user configures.** Rollback would depend on it, against ADR 0012.
- **No registry, building on the target server.** It would be limited to one server per application.
- **Building on the control plane's machine**, as ADR 0012 first said. A build is the application's own code, and that machine holds the installation's keys.
