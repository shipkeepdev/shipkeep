# ADR 0028: Agent and control plane upgrades

- Status: Accepted
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

On 2026-11-23 the maintainer chose, and then accepted this record:

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
3. It gives the running binary a second name without it ever leaving its path. It removes a stale `bin/shipkeep-agent.previous.new` left by an interrupted attempt, hard-links the running binary there, then renames it over `bin/shipkeep-agent.previous`. A later upgrade replaces the previous one the same way, and a retry after a crash at any of these steps converges.
4. It renames `.next` onto `shipkeep-agent`, then reports the action as succeeded and exits. systemd starts the new binary.

**The rollback does not depend on the new binary.** The agent's unit is `Type=notify`, restarts always (`StartLimitIntervalSec=0`), and runs a guard before each start.

- **The guard.** `ExecStartPre` runs the installer's own copy of the agent, `/usr/local/libexec/shipkeep-egress`, in an `upgrade-guard` mode, as `shipkeep`. Root owns that copy, and an upgrade never replaces it.
  - While an upgrade is pending, the guard counts the starts in a durable record (temporary file, sync, rename).
  - After 3 starts that did not succeed, it renames `.previous` over `shipkeep-agent`, records the rollback, and clears the pending state. The previous binary then starts, and reports the failed upgrade on its next `Hello`.
  - The guard always exits 0, so that it never keeps the agent from starting.
- **Success.** A new agent with an upgrade pending to its own version tells systemd it is ready (`READY=1`) only after its first `Hello` is acknowledged. At that point it marks the upgrade done.
- **Failure.** If that has not happened within 5 minutes, the new agent exits non-zero. If it hangs before that, systemd stops it after `TimeoutStartSec` (6 minutes). Either way systemd starts it again, and the guard counts that start. So every failure is counted, whatever its kind and however long it takes.
- **A normal start** sends `READY=1` as soon as the agent runs, without waiting for the control plane, since agents must run through its outages (CLAUDE.md rule 10). An upgrade started during an outage fails its `Hello`, and the previous binary comes back.

**Rollout.** The control plane sends `UpgradeAgent` to one server at a time.

- It never sends it while a deployment touches that server.
- It waits for that agent to report the new version before the next one.
- It stops at the first failure.
- The UI shows the version of each agent and offers the upgrade once a release is newer.

### 3. `UpgradeControlPlane`

**Every control plane machine runs an agent.**

- The control plane installer installs and enrolls one in the separate form too. Its node carries the `control-plane` role and is not schedulable: placement never puts an application there.
- On the single-machine form, the agent that is already there gets the role.
- The agent needs what every server needs, Ubuntu 24.04 with systemd and Docker API 1.47, while the control plane alone runs on any Linux with Docker. Elsewhere, the installer installs the control plane without an agent and says so; that control plane is upgraded by hand (SPEC, "Open questions").
- An agent accepts `UpgradeControlPlane` only with that role, which is set in its local configuration by the installer, not by the control plane.

**The agent drives Docker Compose with fixed arguments.** It runs `docker compose` with an argv the agent builds, never a shell (CLAUDE.md rule 1).

- The binary path is fixed.
- The project directory is the fixed `/opt/shipkeep`.
- The files are the ones Docker Compose recorded on the running containers, as `backup.sh` does.
- The subcommands are a closed list: `pull`, `up -d --wait`, `stop`, `run --rm backup …`, `exec -T postgres pg_dump …`.

Its unit gets `/opt/shipkeep` in `ReadWritePaths`, on that machine only. `.env` becomes readable by the `shipkeep` group. The agent is root-equivalent through Docker already (THREAT_MODEL), so this gives it no new power.

**The image is a file the agent writes.** `SHIPKEEP_IMAGE` moves from `.env` to `image.env`, which the agent writes and Compose reads with a second `--env-file`. The passwords stay in `.env`, which the agent only reads.

**The procedure follows ARCHITECTURE section 5:**

1. **Verify.** Download the control plane bundle of the version (`shipkeep-control-plane_<version>.tar.gz`) and its Sigstore bundle, with the rules of section 1. Check the image reference it names, which is pinned by digest, against the reference in the action. Check that the disk has room for a second copy of the database.
2. **Snapshot, with nothing writing.**
   - Close the public entry: on a single machine, the agent serves the maintenance page (ADR 0025) on the control plane's own route, which it keeps; on a separate machine, it stops the Compose Caddy. Then stop the control plane, and end any session still open on its database, as the restore of ADR 0026 does. Nothing writes to the database from then on, and PostgreSQL can copy it.
   - Only then, with no request able to start one, check in the database that no deployment is active. If one is, start the control plane again, reopen the entry and refuse: the upgrade is asked again once the deployment ended.
   - Copy the database inside PostgreSQL, as `shipkeep_before_upgrade_<time>` (`CREATE DATABASE … TEMPLATE shipkeep`). The copy never leaves the database server, is never a file in clear, and needs no key to come back. Keep the key-encryption key as `kek.before-upgrade-<time>`, and the current `compose.yml`, `image.env` and `Caddyfile`, under `/var/lib/shipkeep/upgrades/<time>/`.
   - When a backup key is on the server (ADR 0026), also take an instance backup there, for the operator: it is not what the rollback uses, since its identity is kept off the server.
3. **Upgrade.** Write the bundle's files and the new `image.env`, then run `pull` and `up -d --wait` for every service but the public entry. Migrations run in the `migrate` step, as on every start.
4. **Check, still closed to users.** `/api/v1/health`, reached by the agent on the machine, must answer 200 with the new version within 5 minutes, and the agent gateway must accept agents again. Only then does the agent open the public entry again (the route back to the control plane, or the Compose Caddy started). Until then, no user request writes anything. Agents may still write during the check: heartbeats and facts, which a rollback undoes and the next heartbeats rebuild. No agent action runs in that window. The upgrade starts only while no deployment is active, and none can start before the checks pass, since every way to start one, the UI, the API and webhooks, goes through the closed public entry. So a rollback never removes an action that an agent ran.
5. **Roll back on failure.** Stop the control plane, put the previous files and key back, and rename the copy over the migrated database in one transaction, as the restore of ADR 0026 does. Then start the previous image. Once an upgrade succeeds, the copy is dropped after a delay that the operator sets, by default 7 days.

The action is journaled step by step, so an agent restarted in the middle resumes it or rolls it back. During the upgrade the control plane is down: agents keep their workloads and routes (CLAUDE.md rule 10) and reconnect.

**Triggered by an owner.** The UI offers it to an organization owner, with a typed confirmation (rule 7). Agents are upgraded afterwards, as in section 2.

### 4. Delivery order

1. Release signing of each agent archive, and `UpgradeAgent` with its upgrade guard and installer changes. Tests:
   - malicious inputs: version, URL, redirect, archive entries, sizes, a bundle of another workflow, tag or digest, a downgrade;
   - a real swap and rollback in a container with systemd: a new binary that exits, and one that hangs.
2. The agent on separate control plane machines: installer, role, not schedulable.
3. `UpgradeControlPlane`, with its snapshot and rollback, tested by forcing a failed migration, by requesting a deployment during the checks, which must be refused, and by starting one just before the entry closes, which must make the upgrade refuse.
4. The VM acceptance of #240, which also needs #200.

## Consequences

- An upgrade depends on GitHub's release downloads being reachable from the server, and from the control plane machine.
- The trust in a release is the trust in Shipkeep's `release.yml` and in Sigstore's public infrastructure, checked offline. A stolen GitHub account that can push a tag can still publish a release. Protecting tags and the release workflow (branch and tag rules, required reviews) carries that risk.
- The agent on the control plane machine gains the power to replace the control plane. It was root-equivalent there through Docker already.
- `sigstore-go` and its dependencies enter the agent, and are checked by the license job (Apache-2.0).
- Installations made before this change need the installer's new agent unit, with its guard. The agent refuses `UpgradeAgent` while its unit has no `upgrade-guard` step, and says to run the server installer with `--migrate yes`. An agent of 0.1.0-alpha.3 or earlier does not know `UpgradeAgent` at all, and is migrated the same way (#490).
  - **What is migrated.** Only a server the installer set up for applications, with the agent and Caddy units an installer wrote, unchanged, for the control plane whose command is run. Anything else is refused before any change.
  - **How.** The migration records the routes the old agent left unrecorded (`adopt-routes`, ADR 0017). It then installs the agent the control plane serves and the guarded unit, binary first, since the unit waits for a READY that old agents never send, and finally the egress proxy, whose Docker restart gives containers new addresses.
  - **What is kept.** The node's identity and credentials, the journal, the containers and volumes, Caddy's configuration and certificates.
  - **Interrupted.** Each step leaves a server that runs, and running the migration again goes on from where it stopped. It restarts Docker only while Docker is not behind the proxy yet.
- A control plane upgrade needs room for a second copy of the database, for as long as the copy is kept. It no longer needs a backup key on the server, since the rollback does not decrypt anything.
- The control plane is stopped from the snapshot to the end of the upgrade. Agents keep their workloads and routes meanwhile.
- `SHIPKEEP_IMAGE` moves to `image.env`, a change in INSTALL.md's upgrade steps.
