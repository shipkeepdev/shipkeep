# ADR 0028: Agent and control plane upgrades

- Status: Proposed
- Date: 2026-11-23

## Context

M8.3b (#240) asks for two upgrades, each with a rollback, tested on a VM by forcing a failure:

- `UpgradeAgent`: replace the agent binary on a server, after checking its signature, and go back to the previous binary if the new one fails.
- `UpgradeControlPlane`: upgrade the control plane, after a snapshot, and go back to it if the new version fails (ARCHITECTURE section 5).

Both actions are in the closed list (`proto/shipkeep/agent/v1/actions.proto`). Neither is implemented: the agent refuses them.

What exists today:

- Releases are signed without a key. Sigstore issues a short-lived certificate to `release.yml`, through GitHub's OIDC identity. The image is signed with `cosign sign`, the control plane bundle with `cosign sign-blob --bundle`, and GoReleaser signs `checksums.txt`, which lists the agent and CLI archives.
- The agent runs as `shipkeep` from `/var/lib/shipkeep/bin/shipkeep-agent`, a file it owns (`deploy/install.sh`). systemd restarts it (`Restart=always`).
- The control plane runs with Docker Compose in `/opt/shipkeep`, which root owns, and `.env` is root's alone. An agent runs on that machine only in the single-machine form (ADR 0021). Upgrading is manual: edit `SHIPKEEP_IMAGE`, `docker compose pull`, `up -d`.

On 2026-11-23 the maintainer chose:

- the agent verifies a new binary against the release's Sigstore signature, offline;
- the agent upgrades the control plane, as ARCHITECTURE section 5 plans, rather than an operator script.

## Decision

### 1. What the agent trusts

**A release is what `release.yml` signed for its tag.** The agent verifies a Sigstore bundle with `sigstore-go` (Apache-2.0) and refuses anything else. In particular, it checks that:

- the certificate was issued by `https://token.actions.githubusercontent.com` to `https://github.com/shipkeepdev/shipkeep/.github/workflows/release.yml@refs/tags/v<version>`, exactly, for the version the action names;
- the signature is in the transparency log, with the inclusion proof that the bundle carries;
- the signed digest is the digest of the bytes it downloaded.

**The trusted root is embedded.** Each agent build embeds Sigstore's trusted root (the certificate authorities and log keys), taken at build time from Sigstore's TUF repository. Verification needs no network, so no Sigstore service is involved at upgrade time.

- A key that Sigstore rotates is in the roots of the agents built after the rotation.
- An agent too old to know the new key refuses the upgrade, and says so. It is then upgraded by running the installer again.

**Each agent archive is signed on its own.** `release.yml` signs each `shipkeep-agent_<version>_linux_<arch>.tar.gz` with `cosign sign-blob --bundle`, and publishes `<archive>.sigstore.json` next to it. This way the agent does not go through `checksums.txt`.

**Never a downgrade.** The agent refuses a version that is not greater than its own (semantic versioning, prereleases ordered). Going back is the rollback of section 2, never an `UpgradeAgent`.

### 2. `UpgradeAgent`

**The control plane names the version, and the agent builds the rest.**

- `UpgradeAgent` carries `version`, `sha256` and the bundle.
- The agent builds the download address itself: `https://github.com/shipkeepdev/shipkeep/releases/download/v<version>/shipkeep-agent_<version>_linux_<arch>.tar.gz`, with `version` matching `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`. It refuses any other `url`.
- It follows HTTPS redirects only to GitHub's release storage hosts, reads at most 64 MiB in at most 10 minutes, and extracts only the `shipkeep-agent` entry, at most 128 MiB, as a regular file.
- The proto keeps its fields; `url` must equal the address the agent builds. Using a mirror would change that rule, by an ADR.

**The swap is journaled.**

1. The agent writes the verified binary to `bin/shipkeep-agent.next`, mode 0755, and syncs it to disk.
2. It records in its journal that an upgrade is pending, from which version to which.
3. It gives the running binary a second name, `bin/shipkeep-agent.previous`, with a hard link: it never leaves the path.
4. It renames `.next` onto `shipkeep-agent`, then reports the action as succeeded and exits. systemd starts the new binary.

**The rollback does not depend on the new binary.** The unit gets `StartLimitBurst=5`, `StartLimitIntervalSec=600` and `OnFailure=shipkeep-agent-rollback.service`.

- The new agent marks the upgrade done once it has connected to the control plane and completed its first `Hello`.
- If it has not done so within 5 minutes, it exits with a dedicated status, and systemd starts it again. A binary that crashes at start fails the same way.
- After five failures, systemd starts `shipkeep-agent-rollback.service`. That unit runs the installer's own copy of the agent, `/usr/local/libexec/shipkeep-egress`, which root owns and an upgrade never replaces, in a `rollback-agent` mode, as `shipkeep`.
  - It puts `.previous` back in place, only while an upgrade is pending.
  - It records the rollback, then clears the start limit and starts the agent again (`ExecStartPost=+systemctl reset-failed …` and `+systemctl start …`, the only commands that run as root).
  - The previous agent then reports the failed upgrade on its next `Hello`.

**Rollout.** The control plane sends `UpgradeAgent` to one server at a time.

- It never sends it while a deployment touches that server.
- It waits for that agent to report the new version before the next one.
- It stops at the first failure.
- The UI shows the version of each agent and offers the upgrade once a release is newer.

### 3. `UpgradeControlPlane`

**Every control plane machine runs an agent.**

- The control plane installer installs and enrolls one in the separate form too. Its node carries the `control-plane` role and is not schedulable: placement never puts an application there.
- On the single-machine form, the agent that is already there gets the role.
- An agent accepts `UpgradeControlPlane` only with that role, which is set in its local configuration by the installer, not by the control plane.

**The agent drives Docker Compose with fixed arguments.** It runs `docker compose` with an argv the agent builds, never a shell (CLAUDE.md rule 1).

- The binary path is fixed.
- The project directory is the fixed `/opt/shipkeep`.
- The files are the ones Docker Compose recorded on the running containers, as `backup.sh` does.
- The subcommands are a closed list: `pull`, `up -d --wait`, `stop`, `run --rm backup …`, `exec -T postgres pg_dump …`.

Its unit gets `/opt/shipkeep` in `ReadWritePaths`, on that machine only. `.env` becomes readable by the `shipkeep` group. The agent is root-equivalent through Docker already (THREAT_MODEL), so this gives it no new power.

**The image is a file the agent writes.** `SHIPKEEP_IMAGE` moves from `.env` to `image.env`, which the agent writes and Compose reads with a second `--env-file`. The passwords stay in `.env`, which the agent only reads.

**The procedure follows ARCHITECTURE section 5:**

1. **Verify.** Download the control plane bundle of the version (`shipkeep-control-plane_<version>.tar.gz`) and its Sigstore bundle, with the rules of section 1. Check the image reference it names, which is pinned by digest, against the reference in the action.
2. **Snapshot.**
   - Take an instance backup (ADR 0026) into `/var/lib/shipkeep/upgrades/<time>/`: the database and the key-encryption key, encrypted to the operator's public key.
   - Keep the current `compose.yml`, `image.env` and `Caddyfile` beside it.
   - Without a backup key on the server (`./backup.sh keygen`), the upgrade is refused: there would be nothing to go back to.
3. **Upgrade.** Write the bundle's files and the new `image.env`, then run `pull` and `up -d --wait`. Migrations run in the `migrate` step, as on every start.
4. **Check.** `/api/v1/health` must answer 200 with the new version within 5 minutes, and the control plane must accept agents again.
5. **Roll back on failure.** Put the previous files back, then restore the snapshot as `backup.sh restore` does: the restored database takes the place of the migrated one, and the previous image runs.

The action is journaled step by step, so an agent restarted in the middle resumes it or rolls it back. During the upgrade the control plane is down: agents keep their workloads and routes (CLAUDE.md rule 10) and reconnect.

**Triggered by an owner.** The UI offers it to an organization owner, with a typed confirmation (rule 7). Agents are upgraded afterwards, as in section 2.

### 4. Delivery order

1. Release signing of each agent archive, and `UpgradeAgent` with its rollback unit and installer changes. Tests:
   - malicious inputs: version, URL, redirect, archive entries, sizes, a bundle of another workflow, tag or digest, a downgrade;
   - a real swap and rollback in a container with systemd.
2. The agent on separate control plane machines: installer, role, not schedulable.
3. `UpgradeControlPlane`, with its snapshot and rollback, tested by forcing a failed migration.
4. The VM acceptance of #240, which also needs #200.

## Consequences

- An upgrade depends on GitHub's release downloads being reachable from the server, and from the control plane machine.
- The trust in a release is the trust in Shipkeep's `release.yml` and in Sigstore's public infrastructure, checked offline. A stolen GitHub account that can push a tag can still publish a release. Protecting tags and the release workflow (branch and tag rules, required reviews) carries that risk.
- The agent on the control plane machine gains the power to replace the control plane. It was root-equivalent there through Docker already.
- `sigstore-go` and its dependencies enter the agent, and are checked by the license job (Apache-2.0).
- Installations made before this change need the installer's new systemd units. The agent refuses `UpgradeAgent` while `shipkeep-agent-rollback.service` is not installed, and says to run the installer again.
- `SHIPKEEP_IMAGE` moves to `image.env`, a change in INSTALL.md's upgrade steps.
