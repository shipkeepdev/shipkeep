# ADR 0032: Builds in their own lane, with live output

- Status: Accepted
- Date: 2026-11-27
- Amends: ADR 0029, ADR 0030

## Context

ADR 0030 runs a build on the server where the application's first replica goes, in rootless BuildKit that the agent drives. Two things it left open matter on the agent side:

- **The journal runs one action at a time per server.** SPEC section 4 has a per-store executor gate, so that no two actions make side effects at once. A build takes from a few seconds to half an hour. Behind the gate, that server would deploy nothing, change no route and run no health check for that whole time.
- **Nobody sees a build.** The log stream of ADR 0029 carries the output of running containers only, labelled through their allocations. Its last paragraph left build output "to be decided with builds". A build is not a container and has no allocation, so the control plane would drop its lines.

## Decision

The maintainer chose both on 2026-11-27.

### A lane for builds

- A `BuildImage` action is journaled like any other: `pending` before anything runs, its steps recorded, resumable after a restart. It runs outside the server-wide executor gate, behind a gate of its own, so a server runs at most one build and, beside it, its other actions one at a time.
- This is safe because a build touches nothing the other actions touch. It talks to BuildKit's socket and the registry only, never to the Docker daemon or Caddy.
- A build is retry-safe as a whole. An agent restart in the middle of one runs it again from its commit, and BuildKit's cache makes that second run short. The second run may still produce another image, for example from a mutable base tag or unpinned packages, and then moves the release's tag to it. Nothing depends on the tag: the action answers the digest of the run that finished, the release records that digest, and pulls use it (ADR 0030).
- One build per server, not more. BuildKit's resources are those of its own unit, which the installer sets (ADR 0030); two builds at once would share them and both slow down.

### Live output on the log stream

- The agent sends a build's output over the existing `ShipLogs` stream, as `LogEntry`s with a new field, `action_id`, and no `container`. A line keeps the existing bounds: 16 KiB, valid UTF-8, secret values redacted. The agent also redacts the action's Git token and registry password.
- The control plane maps `action_id` to the agent action it queued on that node, and from there to its deployment. It writes the lines to VictoriaLogs under the deployment's labels: organization, project, environment, application and deployment, plus the node, with the stream `build`. An entry for an action that is not a build on that node is dropped, like an unknown container's.
- The deployment page reads them back, live while the build runs and kept afterwards for the 30 days of ADR 0029.
- Delivery is at least once while the stream is up. While it is down, the agent buffers a bounded amount of output and drops the oldest lines first. The build itself never waits for the stream.
- `actions.proto` does not change: the action's identifier is all the control plane needs.

## Consequences

- During a build, the rest of the server keeps working. Its CPU, memory and disk are shared with the applications there, within BuildKit's unit limits.
- `logs.proto` gains a backward-compatible field. A control plane that predates it reads such entries as lines without a container and drops them, and an older agent never sends any.
- VictoriaLogs holds build output under the same retention and disk bounds as container logs.
- SPEC section 4 now says that the executor gate is per lane.

## Alternatives considered

- **Builds behind the shared gate.** Simplest, but a long build freezes deployments, routes and health checks on its server.
- **Only the last part of the output, returned with the result.** No proto change, but nothing shows while the build runs. A build that hangs would show nothing until its timeout.
