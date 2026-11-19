# ADR 0022: A disk budget per application container

- Status: Accepted
- Date: 2026-11-19

## Context

Every application container has a CPU, memory, process and log limit, but nothing bounds what it writes to its own filesystem (#347, security audit of 19 November 2026). Docker keeps those writes in the container's writable layer, on the disk it shares with every other container, the images, the agent's state and, on a single machine (ADR 0021), the control plane. One application can fill that disk and stop everything else on the server.

Docker can cap the writable layer only with some storage drivers (`overlay2` on XFS with project quotas, `btrfs`, `zfs`). The default Ubuntu 24.04 server, `overlay2` on ext4, cannot, and a container created with that option there fails to start. A hard quota would need a dedicated XFS filesystem prepared by the installer, and a new field in `CreateContainer` for Docker's storage option.

The agent contract already has two pieces that help: `read_only_rootfs` in `ContainerSpec`, and mounts limited to named volumes and bounded tmpfs (SPEC 3.4).

To be decided:

- what bounds an application's writes on any supported server;
- when an application can have a hard bound instead;
- what happens to a container that exceeds its budget;
- how placement keeps a server from being chosen when it has no room.

## Decision

The maintainer chose a budget measured by the agent by default, and a read-only root filesystem as an option.

- **A disk budget per container, by default.** `resources.disk` in `shipkeep.yml` is the size the container's writable layer may reach. It is 1Gi when left out, between 64Mi and 1Ti, written like `memory`. The control plane sends it in `Resources.disk_bytes`, a new field of the agent contract (below).
- **The agent measures and enforces it.** Every 60 seconds, the agent asks Docker for the size of the writable layer of each managed container (`SizeRw`). A container above its budget is stopped with a grace period of 5 seconds, whatever its own stop timeout, then killed. Its recorded intent becomes "stopped", so the reconciler does not start it again, and the state report names the reason (`disk_limit`) for as long as the container exists. The container stays stopped until a deployment replaces it. The agent logs the container's name, its budget and the size it reached, never the paths or the content written.
- **The budget is not a hard bound.** The guide says so, with its limits:
  - a container can exceed its budget by what it writes between two measurements (up to 60 seconds) and during the 5-second grace period of the stop;
  - `SizeRw` walks the files of the writable layer, so it misses a file that a process deleted while it still holds it open and writes to: an application that does this on purpose is not stopped;
  - writes to named volumes and logs are not part of the budget (logs have their own limit);
  - neither are writes to the anonymous volumes Docker creates for each `VOLUME` an image declares, nor to the `/etc/hosts`, `/etc/resolv.conf` and `/etc/hostname` files Docker keeps on the host for each container.

  An application that must be bounded against such evasion runs with `run.read_only_root`. The measurement costs one Docker API call per minute, which walks every writable layer.

- **A read-only root filesystem as an option, for a hard bound.** With `run.read_only_root: true`, the container gets `read_only_rootfs` and a tmpfs at `/tmp` of 64Mi. tmpfs pages count against the container's memory limit, so the kernel bounds them. Its other writable paths are its declared volumes, and:
  - an image that declares a `VOLUME` would get an anonymous volume, unbounded, at that path. With a read-only root the agent refuses to create the container unless the spec mounts something at each such path; the deployment fails with a reason that says the image declares a volume the configuration does not mount.
  - whether the three files Docker keeps on the host (`/etc/hosts`, `/etc/resolv.conf`, `/etc/hostname`) stay writable under a read-only root is checked by the acceptance test. If they do, the guide says so. The option is off by default because many images write outside `/tmp` (nginx under `/var/cache`, for instance) and fail on a read-only root.
- **Placement checks the disk.** A replica is placed on a node only if the free disk the node last reported (`disk_free_bytes`) leaves its budget plus a margin of 2 GiB for images and the agent. This is a check at placement, not a reservation like CPU and memory: images, volumes and logs also use the disk, and the free space is what counts. A deployment refused for lack of disk says so.
- **Volumes are not covered.** Named volumes stay unbounded, as declared in `shipkeep.yml`. Image retention is #217.

### Contract changes

Both are new fields, wire-compatible, and change no action: the action list is unchanged.

- `actions.proto`, `Resources`: `uint64 disk_bytes = 4`. Zero means no budget, for control planes older than this field. The agent records the budget on the container as the agent-owned label `sk.disk_bytes`, and refuses that label in the labels it receives. The control plane always sends a non-zero budget.
- `gateway.proto`, `ContainerStatus`: `string stop_reason = 9`, empty or `disk_limit`.

## Alternatives considered

- **Hard quotas through the storage driver (`storage-opt size`).** The strongest bound, but only on an XFS filesystem with project quotas. That means a partition or a loop device prepared by the installer, a new field in `CreateContainer`, and a failure on every server installed otherwise. It can be added later for operators who prepare such a filesystem.
- **A read-only root filesystem by default.** A hard bound everywhere, but it breaks every image that writes outside its volumes and `/tmp`. Kept as an option.
- **Removing the container instead of stopping it.** It would also free the disk at once, but it removes what an operator needs to understand what happened. A stopped container keeps its layer until the next deployment removes it. On a full disk the operator can remove it.
- **Monitoring the node's free space only.** It shows that the disk fills, not which application fills it, and stopping something then is a guess.

## Consequences

- An application that fills its writable layer by mistake stops by itself once it exceeds its budget, plus what it writes in up to 65 seconds. The budget reserves no disk: images, volumes, logs and other applications can still fill the server, and a container under its budget can then be the one that runs out of space. The placement check only keeps new replicas off a server that is already short.
- With `run.read_only_root`, a container writes only to its memory, its declared volumes and its logs, plus the three host files above if the acceptance test shows they stay writable.
- Applications that write more than 1Gi to their own filesystem need `resources.disk` raised, or a volume. The deployment does not fail for this: the container stops when it crosses the budget, and the page of the application shows why.
- Agents older than this ADR ignore `disk_bytes`, a field they do not know: a container they create runs without a budget, and their state reports never carry `disk_limit`. Deployments are not refused for this; the window lasts until the server's agent is upgraded (agents upgrade after the control plane, ARCHITECTURE section 5). After the upgrade, containers created before it still have no `sk.disk_bytes` label and stay unmeasured until their next deployment. The read-only root works on older agents (`read_only_rootfs` and tmpfs mounts are older), without the refusal of undeclared image volumes. The server page will show the agent version, so an operator can see which servers enforce the budget.
- New code: the schema fields and their validators (TypeScript and Go, shared fixtures), the API passing `disk_bytes`, `read_only_rootfs` and the `/tmp` tmpfs, the agent's measurement loop, the stop and the reason in the state report, the reason shown on the application page, and the placement check. Each piece has malicious-input tests: oversized and zero budgets, a forged `sk.disk_bytes` label, and the bounds of the schema.
- The acceptance test runs on a disposable filesystem: an application that writes past a small budget is stopped, while another application and the agent keep running. It also checks, with a read-only root, that the image's `VOLUME` paths are refused when not declared and whether the three host files can be written.
- `docs/SPEC.md` (3.4 and the configuration reference) and `docs/INSTALL.md` change with the implementation.
