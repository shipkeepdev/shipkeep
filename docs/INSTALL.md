# Installing Shipkeep

> **Status: a prerelease, exercised on one machine, not yet on a public server.** Installing the control plane with the installer, adding a server and deploying an application have run with the published artifacts of [`v0.1.0-alpha.2`](https://github.com/shipkeepdev/shipkeep/releases/tag/v0.1.0-alpha.2) (see [What has been tested](#what-has-been-tested)). A rollback and a restart of the server's container were run with `v0.1.0-alpha.1`. The upgrade steps have not run, and neither a real server, a public certificate nor a real mail provider has been tried. Use it on servers you can afford to lose, and please [report](https://github.com/shipkeepdev/shipkeep/issues) where it breaks.

A Shipkeep installation has two kinds of machines:

- **One control plane**: the web UI, the API and PostgreSQL. It runs with Docker Compose, and an installer sets it up, below.
- **One or more servers** that run your applications. Each runs the Shipkeep agent, which connects out to the control plane. The Servers page gives the command that installs it.

Use a separate machine for the control plane. It listens on ports 80 and 443, which a server running applications also needs for its own Caddy.

## What you need

- A Linux machine, amd64 or arm64, with 2 GB of memory or more. On Ubuntu 24.04 the installer adds Docker when it is absent; on another system, install Docker Engine and its Compose plugin first.
- A DNS name pointing at that machine, for example `shipkeep.example.com`.
- Ports **80** and **443** (web UI, HTTPS certificate) and **7443** (agents) reachable from where they are needed.
- No email account. The installer creates the first account itself. An SMTP account with implicit TLS (port 465) is optional: with it, people sign up and reset their password by email (see [Accounts without email](#accounts-without-email)).

> **`v0.1.0-alpha.2` and earlier need an SMTP account**: their installer asks for one, and the first account is created in the browser and confirmed by email. Follow [the guide of that release](https://github.com/shipkeepdev/shipkeep/blob/v0.1.0-alpha.2/docs/INSTALL.md). What follows describes the releases after it.

## Install the control plane

Each release since `v0.1.0-alpha.2` carries a bundle, `shipkeep-control-plane_<version>.tar.gz`: the installer, the two files it installs and the image it runs, by tag and digest. `v0.1.0-alpha.1` has none: [install it by hand](#install-by-hand).

1. On the machine, download the bundle of a release from the [releases page](https://github.com/shipkeepdev/shipkeep/releases) and unpack it:

   ```sh
   VERSION=<version>
   curl -fsSLO "https://github.com/shipkeepdev/shipkeep/releases/download/v${VERSION}/shipkeep-control-plane_${VERSION}.tar.gz"
   tar -xzf "shipkeep-control-plane_${VERSION}.tar.gz"
   ```

2. Run the installer and answer its questions: the DNS name, then the email address and the password of the first account. The address is the sign-in name, nothing is sent to it. The password has 15 characters or more and is not shown while you type it.

   ```sh
   sudo ./shipkeep-control-plane/install.sh
   ```

3. Open `https://shipkeep.example.com` and sign in with that address and password. Then [back up the key-encryption key](#back-up-the-key-encryption-key).

What the installer does, in order:

| Step     | What it does                                                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checks   | Ports 80, 443 and 7443 are free, the DNS name resolves, no earlier installation or its Docker volumes exist, and the installation directory and every directory above it belong to root alone. A refusal here leaves the machine as it was. |
| Docker   | On Ubuntu 24.04, installs Docker from Docker's own repository when it is absent, and gives apt the pinned signing key only. Volumes of an earlier installation that show again with Docker stop the run before anything is written.         |
| Settings | Writes `compose.yml`, `Caddyfile` and `.env` in `/opt/shipkeep` (`--dir` changes it), with two generated database passwords. `.env` is readable by root only.                                                                               |
| Start    | Downloads the images and starts the stack (see the steps under [Install by hand](#install-by-hand)).                                                                                                                                        |
| Account  | Creates the first account with the command line of the control plane. The password goes to it on standard input, never as an argument or a variable.                                                                                        |
| HTTPS    | Waits until `https://<name>` answers with a valid certificate.                                                                                                                                                                              |

It never overwrites an installation: run again, it refuses. If the certificate has not arrived after two minutes, it says so and exits with an error while the control plane keeps running; see [Troubleshooting](#troubleshooting). The first account exists by then: do not create it again.

The questions are checked before anything is installed, with rules no wider than the control plane's: the password has 15 to 128 characters on one line, and the address is a name of letters, digits and `_ % + -` joined by single dots, then a domain. An address the installer refuses and the control plane accepts (other punctuation in the name) can be given to an account [created afterwards](#accounts-without-email).

Without a terminal, give the answers as options: `--domain` and `--email`. The password of the first account is read from standard input, its first line, never from an option.

For an installation that sends email, add `--smtp-host`, and optionally `--smtp-port` (465 by default), `--smtp-from` and `--smtp-user` (empty when the server asks for no login). The installer then asks for what is missing; the SMTP password is read from standard input too, after the password of the first account.

To check that the bundle was built by this repository's release workflow, download its `.sigstore.json` file from the same release and run:

```sh
cosign verify-blob "shipkeep-control-plane_${VERSION}.tar.gz" \
  --bundle "shipkeep-control-plane_${VERSION}.tar.gz.sigstore.json" \
  --certificate-identity-regexp '^https://github.com/shipkeepdev/shipkeep/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

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

Each server needs a fresh Ubuntu 24.04 (amd64 or arm64) with `curl` and `sudo`, free ports 80 and 443, and outbound access to the control plane on ports 443 and 7443. The control plane never connects to it.

1. In the web UI, open **Servers**, enter your password and choose **Create a join token**. The token is shown once and expires after 15 minutes.
2. Choose **Copy the command** and run it on the server. It downloads the installer from your control plane, checks its checksum, and runs it with `sudo`. If the checksum does not match, it says so and runs nothing.
3. When asked, paste the join token. Its input is hidden, and it never appears in the command.
4. The installer adds Docker (when absent) and Caddy, creates the `shipkeep-agent` and `shipkeep-caddy` services and starts them. Back in **Servers**, the server shows as `ready` within a few seconds.

On failure, `journalctl -u shipkeep-agent` on the server says why. The installer refuses a server that already has Shipkeep or Caddy; [`deploy/README.md`](../deploy/README.md) lists what to remove to start over.

## Back up the key-encryption key

The `kek` step prints `Back it up: it cannot be recreated.` Every secret stored by Shipkeep is encrypted under that key. Without it, a database backup cannot be read.

Run this command, and the `docker compose` commands of the next sections, from the installation directory: `/opt/shipkeep` when the installer made it. After the installer, run them with `sudo`, also when your user can use Docker: `.env` is readable by root only, and it is edited as root.

```sh
docker compose run --rm --no-deps -T kek node -e "process.stdout.write(require('node:fs').readFileSync('/var/lib/shipkeep/kek').toString('base64'))"
```

Store the output in a password manager or another place that is not this server. Do not put it in a file next to the database backups.

## Upgrade

The installer does not upgrade. Change `SHIPKEEP_IMAGE` in `.env` to the new release's tag and digest (the `image` file of its bundle), then run `docker compose pull` and `docker compose up -d`. The `migrate` and `database-role` steps run again before the new control plane starts. Take a PostgreSQL backup first: automatic snapshots before upgrades are not built yet.

## Troubleshooting

- **The installer refuses to start:** it names the reason (a busy port, a name that does not resolve, a directory that is not root's alone or lies below one, an earlier installation or its Docker volumes) and has changed nothing. Fix it and run the installer again. One refusal comes later: when Docker was removed and the volumes of an earlier installation remain, they only show once the installer has put Docker back.
- **The installer stopped while starting the stack:** it prints the command that finishes the installation. Keep `.env`: the database is created with the passwords it holds, and the installer will not run a second time on this directory.
- **`migrate` or `database-role` exited with an error:** `docker compose logs migrate database-role`. A changed `POSTGRES_APP_PASSWORD` is the usual cause: an existing login keeps its password, so put the original value back.
- **`control-plane` keeps restarting:** `docker compose logs control-plane`. The first line names every invalid or missing setting.
- **No certificate:** the DNS name must point at this machine and ports 80 and 443 must be reachable from the internet. `docker compose logs caddy` shows the reason. The installer exits with an error when the certificate has not arrived after two minutes; the control plane is running all the same, and Caddy keeps trying, so nothing has to be run again.
- **Starting over, on a machine you can afford to lose:** `docker compose down --volumes` in the installation directory, then remove that directory. This deletes the database and the key-encryption key, and with them everything Shipkeep stored.

## What has been tested

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
