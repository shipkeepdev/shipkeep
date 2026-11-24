# Installing Shipkeep

> **Status: a prerelease, exercised on one machine, not yet on a public server.** Installing the control plane with the installer, adding a server and deploying an application have run with the published artifacts of [`v0.1.0-alpha.3`](https://github.com/shipkeepdev/shipkeep/releases/tag/v0.1.0-alpha.3), without an email account (see [What has been tested](#what-has-been-tested)). A rollback and a restart of the server's container were run with `v0.1.0-alpha.1`. The upgrade steps have not run, and neither a real server, a public certificate nor a real mail provider has been tried. Use it on servers you can afford to lose, and please [report](https://github.com/shipkeepdev/shipkeep/issues) where it breaks.

A Shipkeep installation has two kinds of machines:

- **One control plane**: the web UI, the API and PostgreSQL. It runs with Docker Compose, and an installer sets it up, below.
- **One or more servers** that run your applications. Each runs the Shipkeep agent, which connects out to the control plane. The Servers page gives the command that installs it.

One machine can be both: the installer asks whether applications also run on the machine of the control plane, and says yes by default (see [One machine for everything](#one-machine-for-everything)). A separate machine for the control plane stays possible, and is safer when the applications run code you trust less than the control plane.

## What you need

- A Linux machine, amd64 or arm64, with 2 GB of memory or more. On Ubuntu 24.04 the installer adds Docker when it is absent; on another system, install Docker Engine and its Compose plugin first.
- A DNS name pointing at that machine, for example `shipkeep.example.com`.
- Ports **80** and **443** (web UI, HTTPS certificate) and **7443** (agents) reachable from where they are needed.
- No email account. The installer creates the first account itself. An SMTP account with implicit TLS (port 465) is optional: with it, people sign up and reset their password by email (see [Accounts without email](#accounts-without-email)).

> **`v0.1.0-alpha.2` and earlier need an SMTP account**: their installer asks for one, and the first account is created in the browser and confirmed by email. Follow [the guide of that release](https://github.com/shipkeepdev/shipkeep/blob/v0.1.0-alpha.2/docs/INSTALL.md). What follows describes the releases after it.

## Install the control plane

Each release since `v0.1.0-alpha.2` carries a bundle, `shipkeep-control-plane_<version>.tar.gz`: the installer, the two files it installs and the image it runs, by tag and digest. `v0.1.0-alpha.1` has none: [install it by hand](#install-by-hand).

1. On the machine, download the bundle of a release from the [releases page](https://github.com/shipkeepdev/shipkeep/releases), with its signature:

   ```sh
   VERSION=<version>
   BUNDLE="shipkeep-control-plane_${VERSION}.tar.gz"
   curl -fsSLO "https://github.com/shipkeepdev/shipkeep/releases/download/v${VERSION}/${BUNDLE}" &&
   curl -fsSLO "https://github.com/shipkeepdev/shipkeep/releases/download/v${VERSION}/${BUNDLE}.sigstore.json"
   ```

2. Check that the bundle was built by this repository's release workflow for exactly this version, and unpack it only then. The check uses [cosign](https://github.com/sigstore/cosign); the first command downloads version 3.1.4 and deletes it unless its SHA-256 is the one written here. Skip it if `cosign` 3.1 or newer is already installed, and write `cosign` instead of `./cosign`.

   ```sh
   case "$(uname -m)" in
     x86_64) COSIGN=amd64 COSIGN_SHA256=424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa ;;
     aarch64 | arm64) COSIGN=arm64 COSIGN_SHA256=ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2 ;;
   esac
   curl -fsSLo cosign "https://github.com/sigstore/cosign/releases/download/v3.1.4/cosign-linux-${COSIGN}" &&
   echo "${COSIGN_SHA256}  cosign" | sha256sum --check --strict &&
   chmod +x cosign || rm -f cosign
   ```

   ```sh
   ./cosign verify-blob "$BUNDLE" --bundle "$BUNDLE.sigstore.json" \
     --certificate-identity "https://github.com/shipkeepdev/shipkeep/.github/workflows/release.yml@refs/tags/v${VERSION}" \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com &&
   tar -xzf "$BUNDLE"
   ```

   `Verified OK`, then nothing else, means the bundle is unpacked. Any error means it is not: a modified file, a signature for another version or from another workflow, or a missing signature. Do not go on. What this proves: the file is the one that this repository's release workflow signed when it ran for the tag `v<version>`. It relies on GitHub for this page and the SHA-256 of cosign, and on Sigstore for the signature.

3. Run the installer and answer its questions: the DNS name, then the email address and the password of the first account. The address is the sign-in name, nothing is sent to it. The password has 15 characters or more and is not shown while you type it.

   ```sh
   sudo ./shipkeep-control-plane/install.sh
   ```

4. Open `https://shipkeep.example.com` and sign in with that address and password. Then [back up the key-encryption key](#back-up-the-key-encryption-key).

What the installer does, in order:

| Step     | What it does                                                                                                                                                                                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checks   | Ports 80, 443 and 7443 are free, the DNS name resolves, no earlier installation or its Docker volumes exist, and the installation directory and every directory above it belong to root alone. A refusal here leaves the machine as it was.                                                                           |
| Docker   | On Ubuntu 24.04, installs Docker from Docker's own repository when it is absent, and gives apt the pinned signing key only. Volumes of an earlier installation that show again with Docker stop the run before anything is written.                                                                                   |
| Settings | Writes `compose.yml`, `Caddyfile` and `.env` in `/opt/shipkeep` (`--dir` changes it), with two generated database passwords. `.env` is readable by root only.                                                                                                                                                         |
| Start    | Downloads the images and starts the stack (see the steps under [Install by hand](#install-by-hand)).                                                                                                                                                                                                                  |
| Account  | Creates the first account with the command line of the control plane. The password goes to it on standard input, never as an argument or a variable.                                                                                                                                                                  |
| Agent    | On Ubuntu 24.04 with systemd, creates the first organization (asked, or `--organization`) and installs this machine's agent from the control plane image, enrolled over loopback (ADR 0028). It runs no application: no Caddy, no egress proxy, and placement never picks it. On another system this step is skipped. |
| HTTPS    | Waits until `https://<name>` answers with a valid certificate.                                                                                                                                                                                                                                                        |

It never overwrites an installation: run again, it refuses. If the certificate has not arrived after two minutes, it says so and exits with an error while the control plane keeps running; see [Troubleshooting](#troubleshooting). The first account exists by then: do not create it again.

The questions are checked before anything is installed, with rules no wider than the control plane's: the password has 15 to 128 characters on one line, and the address is a name of letters, digits and `_ % + -` joined by single dots, then a domain. An address the installer refuses and the control plane accepts (other punctuation in the name) can be given to an account [created afterwards](#accounts-without-email).

Without a terminal, give the answers as options: `--domain` and `--email`. The password of the first account is read from standard input, its first line, never from an option.

For an installation that sends email, add `--smtp-host`, and optionally `--smtp-port` (465 by default), `--smtp-from` and `--smtp-user` (empty when the server asks for no login). The installer then asks for what is missing; the SMTP password is read from standard input too, after the password of the first account.

### Install by hand

The installer only automates these steps. They need Docker Engine and the Compose plugin.

1. Pick a release on the [releases page](https://github.com/shipkeepdev/shipkeep/releases). Get `compose.yml`, `Caddyfile` and `.env.example` from its bundle, or from [`deploy/control-plane`](../deploy/control-plane) in the repository at that release's tag. Put them in one directory, for example `/opt/shipkeep`.
2. Copy `.env.example` to `.env` and fill it in. Keep the file private: `chmod 600 .env`.
   - `SHIPKEEP_IMAGE` is the release, by tag **and digest**: copy it from the `image` file of the bundle, or from the `SHIPKEEP_IMAGE=…` line at the bottom of the release notes. You can check that the image was built by this repository's release workflow:

     ```sh
     # Paste the same reference you put in .env.
     SHIPKEEP_IMAGE='ghcr.io/shipkeepdev/shipkeep:<version>@sha256:<digest>'
     cosign verify "$SHIPKEEP_IMAGE" \
       --certificate-identity-regexp '^https://github.com/shipkeepdev/shipkeep/\.github/workflows/release\.yml@refs/tags/v' \
       --certificate-oidc-issuer https://token.actions.githubusercontent.com
     ```

   - Generate the two database passwords with `openssl rand -hex 32`.
3. Start it:

   ```sh
   docker compose up -d
   ```

   Compose starts PostgreSQL, then runs three one-shot steps, then starts the control plane and Caddy:

   | Step            | What it does                                                       |
   | --------------- | ------------------------------------------------------------------ |
   | `kek`           | Creates the key-encryption key once, in the `keys` volume.         |
   | `migrate`       | Applies the database migrations as the database administrator.     |
   | `database-role` | Creates the restricted login the API uses, and applies its grants. |

4. Check that everything is up:

   ```sh
   docker compose ps
   curl -fsS https://shipkeep.example.com/api/v1/health
   ```

   The three one-shot steps show `Exited (0)`. The first HTTPS request can take a few seconds while Caddy obtains the certificate.

5. Create the first account, then open `https://shipkeep.example.com` and sign in. The command asks for the password without showing it:

   ```sh
   docker compose -f compose.yml run --rm --no-deps control-plane node main.js account create --email you@example.com
   ```

## One machine for everything

When the installer asks **Run applications on this machine too?** and you answer yes (the default, or `--single-machine yes`), it also makes this machine a server (ADR 0021):

- It asks for the name of the first organization (or `--organization`), creates it with the first account as owner, and installs the agent and the server's Caddy from the control plane image, enrolled over loopback with a join token that never shows on the screen.
- The server's Caddy owns ports 80 and 443. The control plane runs without its own Caddy and listens on `127.0.0.1:3000` only; the agent keeps its route in Caddy, puts it back if Caddy loses it, and refuses that name to applications.
- 0.5 CPU and 1 GiB stay reserved for the control plane: applications are placed in what is left, and a redeployment whose old and new releases do not fit together beside the reservation is refused before anything starts, with the reason.
- PostgreSQL and the API run in `shipkeep-controlplane.slice`, whose memory up to the reservation the kernel reclaims last, and their containers are the least likely the out-of-memory killer picks. Applications run in `shipkeep-workloads.slice`, limited to the rest of the memory, and are the most likely. This is a preference the kernel follows, not a guarantee: under enough pressure it can still reclaim protected memory or stop a process of the control plane.

It needs Ubuntu 24.04 with systemd (the system every server needs), at least 2 CPUs and 3 GiB of memory, cgroup v2 mounted with `memory_recursiveprot` (systemd 247 or later, as on Ubuntu 24.04), Docker's `systemd` cgroup driver (the default with cgroup v2), Docker Engine 28 or later (older engines let other machines of the local network reach ports published on `127.0.0.1`, where the control plane listens) and Docker Compose 2.24.4 or later (the first that reads the `!override` of `compose.single-machine.yml`), with ports 3000 and 7480 free. The installer checks all of them before it changes anything and refuses the single-machine form otherwise; answer no to install the control plane alone, on any Linux with Docker.

On such a machine, give Docker Compose both files: `sudo docker compose -f compose.yml -f compose.single-machine.yml <command>`, for example to upgrade. The certificate comes from the server's Caddy: `sudo journalctl -u shipkeep-caddy` shows its reasons.

The control plane and the applications then share a kernel: an application that escapes its container reaches the key-encryption key and the database. Use two machines for code you do not trust as much as the control plane.

## Accounts without email

An installation whose `.env` has no `SMTP_HOST` sends no email. Nobody can sign up or ask for a reset link there: the sign-up and "forgot password" requests are refused, and accounts are handled on the machine that runs the control plane. Whoever can run these commands already holds the database and the key-encryption key.

Create an account for someone else. The command asks for a password of 15 characters or more, without showing it:

```sh
cd /opt/shipkeep
sudo docker compose -f compose.yml run --rm --no-deps control-plane node main.js account create --email person@example.com
```

That person signs in with the address and the password, and can change the password afterwards. To give them access to an organization, add them under Members & access, as for any account.

Give an account a new password when its owner lost it:

```sh
sudo docker compose -f compose.yml run --rm --no-deps control-plane node main.js account reset-password --email person@example.com
```

Its sessions and API tokens stop working at once. A second factor stays as it is: the recovery codes of the account are the way back.

To turn email on later, set `SMTP_HOST` and `SMTP_FROM` in `.env`, and `SMTP_USER` and `SMTP_PASSWORD` if the server asks for a login, then run `sudo docker compose -f compose.yml up -d`. The same accounts keep working, and people can then sign up and reset their password by email.

## Add a server

Each server needs a fresh Ubuntu 24.04 (amd64 or arm64) with `curl` and `sudo`, free ports 80 and 443 (and 7480 on loopback), and outbound access to the control plane on ports 443 and 7443. The control plane never connects to it. If `/etc/docker/daemon.json` exists, it must not set a proxy (`proxies`, `http-proxy`, `https-proxy`, `no-proxy`): the installer refuses it.

1. In the web UI, open **Servers**, enter your password and choose **Create a join token**. The token is shown once and expires after 15 minutes.
2. Choose **Copy the command** and run it on the server. It downloads the installer from your control plane, checks its checksum, and runs it with `sudo`. If the checksum does not match, it says so and runs nothing.
3. When asked, paste the join token. Its input is hidden, and it never appears in the command.
4. The installer adds Docker (when absent) and Caddy, creates the `shipkeep-agent`, `shipkeep-caddy` and `shipkeep-egress` services and starts them. Back in **Servers**, the server shows as `ready` within a few seconds.

Docker pulls every image through `shipkeep-egress`, a proxy on `127.0.0.1:7480` that connects only to public addresses over HTTPS, and an nftables table, `inet shipkeep_egress`, keeps the Docker daemon off the server's loopback (ADR 0023). This holds for every pull of this Docker daemon, including any you run yourself. The installer restarts Docker once to apply it, so containers already running restart with it.

- Before each pull, the agent checks that Docker still goes through the proxy. If a later change to `daemon.json` or to another drop-in of `docker.service` sets a proxy, the deployment fails, saying that Docker does not go through its egress proxy. Remove that setting and restart Docker.
- The Docker daemon runs in its own slice, `shipkeep.slice`. `nftables.service` loads the guard together with `/etc/nftables.conf` whenever it starts, reloads or stops. Do not flush the whole ruleset by hand (`nft flush ruleset`): it removes the guard until Docker starts again (`sudo systemctl restart docker`).
- Registries on a private network are not supported yet.
- A server installed before this change has neither the proxy nor the guard. Its agent keeps pulling as before until it is upgraded; an agent from this release refuses to pull on it. Install the server again to get them.

On failure, `journalctl -u shipkeep-agent` (or `-u shipkeep-egress` for a refused pull) on the server says why. The installer refuses a server that already has Shipkeep or Caddy; [`deploy/README.md`](../deploy/README.md) lists what to remove to start over.

## Back up and restore

`backup.sh`, next to `compose.yml`, saves what the control plane cannot recreate: its database, which holds the certificate authority and every secret, and the key-encryption key those secrets are encrypted with (ADR 0026). The archive is encrypted to a key pair that you keep off this server. Run it with `sudo` from the installation directory. An installation made before this script existed takes it from the release bundle.

Once, create the key pair:

```sh
sudo ./backup.sh keygen backup-identity.txt
```

Copy `backup-identity.txt` to a password manager or another place that is not this server, then delete it here. Whoever holds it can read every backup and every secret in it, and a restore needs it. The server keeps only what making backups needs, in the `keys` volume: the public key they are encrypted to, and a key derived from the identity that authenticates each archive. A restore refuses an archive it does not authenticate, so someone who knows the public key and can replace an archive where you keep it still cannot have it restored. Running `keygen` again replaces that pair for the backups that follow; earlier archives open with the identity they were made for.

Create a backup, then copy it off this server:

```sh
sudo ./backup.sh create shipkeep-$(date +%Y%m%d-%H%M).age
```

`pg_dump` runs in the PostgreSQL container and streams through the encryption. No plaintext dump is written to disk.

To send backups to S3 instead, or as well, set the `SHIPKEEP_BACKUP_S3_*` settings in `.env` (`.env.example` lists them). They work with any S3-compatible storage: AWS, Backblaze B2, Cloudflare R2, Scaleway, Wasabi or MinIO. Give the access key the right to write, read, list and delete objects under the prefix, then check the settings:

```sh
sudo ./backup.sh check
sudo ./backup.sh create --s3    # streams straight to the storage; the archive is never a file here
sudo ./backup.sh list
```

The archive is encrypted before it leaves this server, and the container that uploads it never sees the key. An archive is never replaced. If a backup fails after its upload, the script deletes what it stored, or names it for you to delete when it cannot. Keep backups as long as you need with the storage's lifecycle rules. Whoever holds the access key can delete backups too: give it only the prefix, and turn on the bucket's versioning or object lock so that a deleted backup can be recovered. For a backup every night at 03:00, add a line to root's crontab (`sudo crontab -e`):

```text
0 3 * * * cd /opt/shipkeep && ./backup.sh create --s3
```

Restore into a fresh installation of the same version or a later one, on the same domain:

1. Install the control plane on the new machine with the installer.
2. Copy the archive and the identity file there.
3. Run:

```sh
sudo ./backup.sh restore shipkeep-20261123-1000.age backup-identity.txt
# or, from the S3 destination (the same settings in .env):
sudo ./backup.sh restore s3:shipkeep-20261123-100000-3f9a1c2e.age backup-identity.txt
```

It asks you to type `replace`, then:

1. stops the control plane;
2. restores the database into a new one, which takes the place of the current database only once complete; the current one is kept as `shipkeep_before_restore_…`, to drop once you are satisfied (the script prints the command);
3. replaces the key-encryption key, keeping the previous one beside it, and keeps backing up to the identity you restored with;
4. starts everything again, which applies the migrations of this version.

The restore prints the time the backup was made: check that it is the one you meant. Someone who can write to where archives are kept cannot forge one, but could put an older backup in its place.

Point the domain to the new machine: the servers reconnect on their own, with the identity they already have. Everyone signs in again: the restore ends every session.

The restore brings back the installation as it was when the backup was made. A password changed since then is the previous one again, an API token revoked since is valid again, and a member removed since is back. After a compromise, change those passwords, revoke those tokens and remove those members again. A backup from a newer version is refused. Sessions come back with the database. Metrics, Caddy's certificate and the `.env` settings do not: the SMTP settings are typed again.

If a step fails, the script says what state it left and stops there, with the control plane stopped. Until the restored database takes the place of the current one, the current one is unchanged. If the key step fails after that, the restored database is in place, and the key file holds this installation's key or the restored one, never neither: run the restore again before starting the control plane. The previous database is kept under the name the script prints.

### Back up the key-encryption key

The `kek` step prints `Back it up: it cannot be recreated.` The archive above holds the key. To keep a copy of the key alone as well:

Run this command, and the `docker compose` commands of the next sections, from the installation directory: `/opt/shipkeep` when the installer made it. After the installer, run them with `sudo`, also when your user can use Docker: `.env` is readable by root only, and it is edited as root.

```sh
docker compose run --rm --no-deps -T kek node -e "process.stdout.write(require('node:fs').readFileSync('/var/lib/shipkeep/kek').toString('base64'))"
```

Store the output in a password manager or another place that is not this server. Do not put it in a file next to the database backups.

## Upgrade

The installer does not upgrade. In the installation directory, replace `compose.yml` with the one of the new release's bundle: it pins the PostgreSQL, Caddy, VictoriaMetrics and VictoriaLogs images of that release. Change `SHIPKEEP_IMAGE` in `.env` to the new release's tag and digest (the `image` file of the same bundle), then run `docker compose pull` and `docker compose up -d`. The `migrate` and `database-role` steps run again before the new control plane starts. Take a PostgreSQL backup first: automatic snapshots before upgrades are not built yet. VictoriaMetrics keeps 30 days of metrics in its own volume, `victoriametrics-data`; it is not in a PostgreSQL backup, and losing it loses that history only (ADR 0024). VictoriaLogs keeps 30 days of application logs in `victorialogs-data`, likewise (ADR 0029).

A server's agent can replace itself with a signed release, but the control plane does not ask it to yet (ADR 0028).

- **How it goes.** The agent checks the release's signature and keeps its running binary as `/var/lib/shipkeep/bin/shipkeep-agent.previous`. It restarts on the new one, which has 5 minutes to reach the control plane. A new binary that fails 3 starts is replaced by the previous one, and `journalctl -u shipkeep-agent` says that the upgrade was rolled back.
- **Servers installed before this release.** Their agent refuses the upgrade, saying that its service predates upgrades: its unit lacks the step that puts the previous binary back. Install the server again to get it; [`deploy/README.md`](../deploy/README.md) lists what to remove first.

## Troubleshooting

- **The installer refuses to start:** it names the reason (a busy port, a name that does not resolve, a directory that is not root's alone or lies below one, an earlier installation or its Docker volumes) and has changed nothing. Fix it and run the installer again. One refusal comes later: when Docker was removed and the volumes of an earlier installation remain, they only show once the installer has put Docker back.
- **Docker packages could not be downloaded:** both installers remove the Docker apt source and keyring they added during the failed setup or download. Both APT steps use the normal package cache. HUP/TERM cleanup requires the signal to reach the package-download process. If only the parent installer was terminated, wait for `apt-get` and `dpkg` to stop before retrying. Run the same installer again once the network is back.
- **Docker package application failed or was interrupted:** keep the signed source and keyring. After downloads succeed, the installer keeps them conservatively for the offline APT step, even if a changed package plan, a missing cached archive or a lock prevents `dpkg` from starting. Wait for other `apt-get` and `dpkg` processes to stop, then finish the installation from the retained repository:

  ```sh
  sudo dpkg --configure -a
  sudo apt-get update
  sudo apt-get --fix-broken install
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io
  sudo systemctl enable --now docker
  sudo docker info
  ```

  For the control plane, also run `sudo apt-get install -y docker-compose-plugin` and verify `docker compose version`. Resolve any errors before running the installer again. A partially installed `docker` command makes the installer skip repository setup; repairing only pending packages does not necessarily install every missing Docker package.

- **Power loss or `kill -9` left Docker repository files:** reconcile `/etc/apt/sources.list.d/shipkeep-docker.sources` and `/etc/apt/keyrings/shipkeep-docker.gpg`. Remove them and run the installer again only if you can confirm they were left before package application. If package application may have started, keep them and finish installing and verifying Docker as described above before retrying. Once the old installer, `apt-get` and `dpkg` have stopped, use that attempt's `Docker signing-key workspace:` output to identify and remove its temporary directory under `/tmp`.
- **The installer stopped after writing `.env`** (while starting the stack, creating the account or the organization, or adding this machine as a server): keep `.env`, since the database is created with the passwords it holds. Once the cause is fixed, run the same installer again with `--resume yes`, as it says:

  ```sh
  sudo bash install.sh --dir /opt/shipkeep --resume yes
  ```

  It reads the settings of the interrupted run from `install-state` in that directory, starts the stack and runs only the steps not done yet. It asks for the password again only when the account was not created, and keeps an account, an organization or a server installation that the interrupted run had finished without recording it. When installing this machine's agent stopped after the server installer had begun writing, that installer refuses to run again: remove [the server part, or on a separate machine the agent part](#starting-over), then resume. A run stopped before writing `.env` started nothing: run the installer again, as at first.

- **`migrate` or `database-role` exited with an error:** `docker compose logs migrate database-role`. A changed `POSTGRES_APP_PASSWORD` is the usual cause: an existing login keeps its password, so put the original value back.
- **`control-plane` keeps restarting:** `docker compose logs control-plane`. The first line names every invalid or missing setting.
- **No certificate:** the DNS name must point at this machine and ports 80 and 443 must be reachable from the internet. `docker compose logs caddy` shows the reason, or `sudo journalctl -u shipkeep-caddy` on [one machine for everything](#one-machine-for-everything). The installer exits with an error when the certificate has not arrived after two minutes; the control plane is running all the same, and Caddy keeps trying, so nothing has to be run again.
- **Starting over, on a machine you can afford to lose:** `docker compose down --volumes` in the installation directory (`-f compose.yml -f compose.single-machine.yml` on [one machine](#one-machine-for-everything)), then remove that directory. This deletes the database and the key-encryption key, and with them everything Shipkeep stored. See [Starting over](#starting-over) for the server part of one machine.

### Starting over

On [one machine for everything](#one-machine-for-everything), the machine is also a server: the agent, its Caddy, the egress guard and the applications' containers live on the host, outside Compose, and the installers refuse to run while any of it remains. A separate control plane machine on Ubuntu 24.04 has its agent there too, alone.

**The agent part, on a separate machine.** To resume after installing its agent failed halfway, remove it, as root, then run the installer with `--resume yes`. Its node stays on the Servers page until you remove it there:

```sh
systemctl disable --now shipkeep-agent
rm -rf /etc/shipkeep /var/lib/shipkeep /run/shipkeep /usr/local/libexec/shipkeep-egress /etc/tmpfiles.d/shipkeep.conf \
  /etc/systemd/system/shipkeep-agent.service
userdel shipkeep
systemctl daemon-reload
```

**The server part.** To resume after adding this machine as a server failed halfway, remove only this part, as root, then run the installer with `--resume yes`. It stops and deletes every application on the machine, and keeps the control plane, its slice and its directory:

```sh
systemctl disable --now shipkeep-agent shipkeep-caddy shipkeep-egress
docker ps -aq --filter label=sk.managed=true | xargs -r docker rm -f
nft delete table inet shipkeep_egress 2>/dev/null || true
rm -rf /etc/shipkeep /var/lib/shipkeep /var/lib/shipkeep-caddy /run/shipkeep \
  /etc/shipkeep-caddy.json /etc/shipkeep-egress.nft /etc/shipkeep-nftables.nft /etc/shipkeep-nftables-stop.nft \
  /usr/local/libexec/shipkeep-egress /etc/tmpfiles.d/shipkeep.conf \
  /etc/systemd/system/shipkeep-agent.service /etc/systemd/system/shipkeep-caddy.service /etc/systemd/system/shipkeep-egress.service \
  /etc/systemd/system/shipkeep.slice /etc/systemd/system/shipkeep-workloads.slice \
  /etc/systemd/system/docker.service.d/shipkeep-egress.conf /etc/systemd/system/nftables.service.d/shipkeep-egress.conf
apt-get purge -y caddy
rm -f /etc/apt/sources.list.d/shipkeep-caddy.sources /etc/apt/keyrings/shipkeep-caddy.gpg /etc/apt/keyrings/shipkeep-caddy.asc
userdel shipkeep-egress; userdel shipkeep-caddy; userdel shipkeep
systemctl daemon-reload
systemctl restart docker
# The installer restarts Docker too: forget the restarts counted so far, or systemd refuses one.
systemctl reset-failed docker
if systemctl is-active --quiet nftables; then systemctl restart nftables; fi
```

**Everything, on a machine you can afford to lose.** This deletes the database and the key-encryption key, and with them everything Shipkeep stored. Set `dir` to the directory the installer used (`--dir`, `/opt/shipkeep` by default), remove the stack and its volumes, then the server part above, then the rest:

```sh
dir=/opt/shipkeep
(cd "$dir" && docker compose -f compose.yml -f compose.single-machine.yml down --volumes)
# ... the server part above (on a separate machine: -f compose.yml only, then the agent part) ...
rm -f /etc/systemd/system/shipkeep-controlplane.slice
systemctl daemon-reload
rm -rf -- "$dir"
```

Docker stays installed. The installer then runs again as on a new machine.

## What has been tested

The verification step of [Install the control plane](#install-the-control-plane), on 19 November 2026, with the blocks of this page run as written in fresh Ubuntu 24.04 containers (amd64), on the published `v0.1.0-alpha.3` bundle: cosign 3.1.4 matched its SHA-256, the signature verified and the bundle was unpacked. Each refusal left no installer to run: a bundle with one byte added, a signature for another version (the same bundle under the name and identity of `v0.1.0-alpha.2`), a missing signature, and a cosign whose SHA-256 does not match (the file is deleted, and the check then fails). The arm64 SHA-256 comes from cosign's signed checksum file, verified with cosign; it was not run on arm64.

With the published artifacts of `v0.1.0-alpha.3`, on 19 November 2026, in fresh Ubuntu 24.04 containers with systemd and without Docker, following this page from its first command and without any email account:

- The bundle downloaded from the release, and the `cosign verify-blob` command above: it succeeds, and it fails when given another identity or a modified file. The image signature verifies with `cosign verify`, and fails for another identity.
- The installer through a terminal, answering its three questions: the DNS name, the address and the password of the first account. It asked nothing about email, the password did not appear in its output, the account was created, and the control plane reports `0.1.0-alpha.3` with email off. The test name was not public, so no certificate could be issued and the run ended the way this page describes for that case.
- On that installation, once Caddy was switched to its internal certificate authority (by hand, for the test): sign-in with the account the installer created, an organization, a server added with the command and the token copied from the Servers page (its agent reports `0.1.0-alpha.3`, the token does not appear in the installer's output), and a deployment of `docker.io/traefik/whoami:v1.10.3` that succeeded and answers through that server's Caddy. It answers on plain HTTP as well, instead of redirecting to HTTPS ([#342](https://github.com/shipkeepdev/shipkeep/issues/342)).

With the published artifacts of `v0.1.0-alpha.2`, on 15 November 2026, in fresh Ubuntu 24.04 containers with systemd and without Docker, following this page from its first command:

- The bundle downloaded from the release, and the `cosign verify-blob` command above: it succeeds, and it fails when given another identity or a modified file. The image signature verifies the same way.
- The installer through a terminal, left alone until it ended: Docker 29 and Compose 5.7 installed, the image pulled by tag and digest without credentials, the settings written, the three one-shot steps exiting 0, the control plane healthy and reporting `0.1.0-alpha.2`. The test name was not public, so no certificate could be issued and the run ended the way this page describes for that case. Run again, it refuses the existing installation.
- On that installation, once Caddy was switched to its internal certificate authority and a local mail server that checks the login was added (both by hand, for the test): sign-up with the confirmation email, sign-in, a server added with the command from the Servers page (its agent reports `0.1.0-alpha.2`), and a deployment of `docker.io/traefik/whoami:v1.10.3` that succeeded and answers through that server's Caddy.

With the published artifacts of `v0.1.0-alpha.1`, on 13 November 2026, on one machine with Docker Engine 29 and Compose 2.40, in a single run that started from nothing, with `compose.yml` and `.env.example` taken from the tag:

- The image pulled by tag and digest without credentials, and the `cosign verify` command above: it succeeds, and it fails when given another identity.
- `docker compose up -d`: the three one-shot steps exit 0, the control plane becomes healthy and answers over HTTPS through Caddy (with Caddy's internal certificate authority, since the test name was not public).
- Sign-up with the confirmation email (a local mail server with implicit TLS), sign-in, an organization, a project and an environment.
- The install command copied from the Servers page, run in an Ubuntu 24.04 container with systemd: it exits 0, Docker and Caddy are installed, the agent enrolls with version `0.1.0-alpha.1`, the server shows as `ready` and the token file is removed. Run again on that server, it refuses and exits 1.
- A deployment of `docker.io/traefik/whoami:v1.10.3`: network, pull by digest, container, health check, route, state `succeeded`, and the application answering through the server's Caddy.
- A restart of the server's container, with Docker's storage on disk. It is the closest this setup gets to a reboot, and it is not one: the three services come back, the application's container restarts, Caddy serves its route again, and the server shows as `ready` again. Then a second deployment, and a rollback to the first release.
- The agent and CLI archives of the release: their checksums match `checksums.txt`, and both binaries report the release version.

With an image built from the same code (`main` at `8eeef12`) on 12 November 2026, on the same machine:

- Restarting the control plane, restarting Caddy, and the control plane process exiting on its own: the site answers again each time without manual action. After a reboot of the machine itself, the whole stack came back and sign-in worked with the same account.
- The install command with a wrong checksum: it reports the mismatch, runs nothing and exits 1.
- Deployments of images written as `owner/image`, `index.docker.io/owner/image`, `nginx` and `docker.io/library/nginx`.
- On the server: restarting Caddy and killing it with `kill -9` (the route keeps serving and the admin socket keeps mode 0660, with no TCP admin listener), and restarting the agent (it reconnects).

The control plane installer, on 15 November 2026, from a bundle built with `deploy/control-plane/build-bundle.sh` around the published `v0.1.0-alpha.1` image, in fresh Ubuntu 24.04 containers with systemd and without Docker:

- A run through a terminal: an invalid answer is asked again, the SMTP password is not shown, Docker 29 and Compose 5.7 are installed, the settings are written (`.env` readable by root only), the three one-shot steps exit 0 and the control plane becomes healthy. The test name was not public, so no certificate could be issued and the run ended the way this page describes for that case: an error after two minutes, with the control plane running.
- On that installation, once Caddy was switched to its internal certificate authority and a local mail server that checks the login was added (both by hand, for the test): sign-up with the confirmation email, with an SMTP password made of quotes, a dollar sign, a backslash, a `#` and spaces that reached the mail server unchanged; sign-in; a server added with the command from the Servers page, through port 7443, with the settings as the installer wrote them; a deployment of `docker.io/traefik/whoami:v1.10.3` answering through that server's Caddy.
- The installer's HTTPS check: it refuses Caddy's internal certificate, accepts it once that authority is trusted, and refuses another name.
- Its refusals, each leaving the machine as it was: without `sudo`, a bundle from a dry run, an incomplete bundle, a directory that belongs to a regular user or lies below such a directory, below a world-writable one or below a link, a link in place of the directory, a leftover settings draft, a busy port, a name that does not resolve, an invalid answer without a terminal. Run again after an installation, it refuses the directory, and with another directory it refuses the Docker volumes.
- Docker removed while the volumes of an earlier installation remained: the installer puts Docker back, then refuses those volumes and writes nothing.
- Starting over as described under [Troubleshooting](#troubleshooting), then a second installation without a terminal (options, and the password on standard input) with Docker already present.

Not tested yet:

- The installer ending with a publicly trusted certificate.
- The provenance attestation of the bundle: GitHub lists one for the published file, and `gh attestation verify` did not answer on the test machine, so it was not verified.
- A real server or virtual machine, its reboot, and a firewall. The server of the test was a privileged container.
- A public DNS name: Caddy obtaining certificates from Let's Encrypt, for the control plane and for an application domain. Applications were checked over HTTP on the server.
- A real SMTP provider.
- arm64 at run time, upgrading from one published release to the next, removing a server, and the released CLI against an installation.
