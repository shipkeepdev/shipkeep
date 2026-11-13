# Installing Shipkeep

> **Status: a prerelease, exercised on one machine, not yet on a public server.** Installing the control plane and adding a server have run with the published artifacts of [`v0.1.0-alpha.1`](https://github.com/shipkeepdev/shipkeep/releases/tag/v0.1.0-alpha.1) (see [What has been tested](#what-has-been-tested)), followed by deployments, a rollback and a restart of the server's container. The upgrade steps have not run, and neither a real server, a public certificate nor a real mail provider has been tried. Use it on servers you can afford to lose, and please [report](https://github.com/shipkeepdev/shipkeep/issues) where it breaks.

A Shipkeep installation has two kinds of machines:

- **One control plane**: the web UI, the API and PostgreSQL. Installed with Docker Compose, below.
- **One or more servers** that run your applications. Each runs the Shipkeep agent, which connects out to the control plane. The Servers page gives the command that installs it.

Use a separate machine for the control plane. It listens on ports 80 and 443, which a server running applications also needs for its own Caddy.

## What you need

- A Linux machine with Docker Engine and the Compose plugin, 2 GB of memory or more.
- A DNS name pointing at that machine, for example `shipkeep.example.com`.
- Ports **80** and **443** (web UI, HTTPS certificate) and **7443** (agents) reachable from where they are needed.
- An SMTP account with implicit TLS (port 465). It is required: accounts are confirmed by email, so the first sign-up fails without it.

## Install the control plane

1. Pick a release on the [releases page](https://github.com/shipkeepdev/shipkeep/releases). From the repository at that release's tag, get the three files of [`deploy/control-plane`](../deploy/control-plane): `compose.yml`, `Caddyfile` and `.env.example`. Put them in one directory, for example `/opt/shipkeep`.
2. Copy `.env.example` to `.env` and fill it in. Keep the file private: `chmod 600 .env`.
   - `SHIPKEEP_IMAGE` is the release, by tag **and digest**: copy the `SHIPKEEP_IMAGE=…` line at the bottom of its release notes. You can check that the image was built by this repository's release workflow:

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

5. Open `https://shipkeep.example.com`, create your account and confirm it with the code sent by email.

## Add a server

Each server needs a fresh Ubuntu 24.04 (amd64 or arm64) with `curl` and `sudo`, free ports 80 and 443, and outbound access to the control plane on ports 443 and 7443. The control plane never connects to it.

1. In the web UI, open **Servers**, enter your password and choose **Create a join token**. The token is shown once and expires after 15 minutes.
2. Choose **Copy the command** and run it on the server. It downloads the installer from your control plane, checks its checksum, and runs it with `sudo`. If the checksum does not match, it says so and runs nothing.
3. When asked, paste the join token. Its input is hidden, and it never appears in the command.
4. The installer adds Docker (when absent) and Caddy, creates the `shipkeep-agent` and `shipkeep-caddy` services and starts them. Back in **Servers**, the server shows as `ready` within a few seconds.

On failure, `journalctl -u shipkeep-agent` on the server says why. The installer refuses a server that already has Shipkeep or Caddy; [`deploy/README.md`](../deploy/README.md) lists what to remove to start over.

## Back up the key-encryption key

The `kek` step prints `Back it up: it cannot be recreated.` Every secret stored by Shipkeep is encrypted under that key. Without it, a database backup cannot be read.

```sh
docker compose run --rm --no-deps -T kek node -e "process.stdout.write(require('node:fs').readFileSync('/var/lib/shipkeep/kek').toString('base64'))"
```

Store the output in a password manager or another place that is not this server. Do not put it in a file next to the database backups.

## Upgrade

Change `SHIPKEEP_IMAGE` in `.env` to the new release's tag and digest, then run `docker compose pull` and `docker compose up -d`. The `migrate` and `database-role` steps run again before the new control plane starts. Take a PostgreSQL backup first: automatic snapshots before upgrades are not built yet.

## Troubleshooting

- **`migrate` or `database-role` exited with an error:** `docker compose logs migrate database-role`. A changed `POSTGRES_APP_PASSWORD` is the usual cause: an existing login keeps its password, so put the original value back.
- **`control-plane` keeps restarting:** `docker compose logs control-plane`. The first line names every invalid or missing setting.
- **No certificate:** the DNS name must point at this machine and ports 80 and 443 must be reachable from the internet. `docker compose logs caddy` shows the reason.

## What has been tested

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

Not tested yet:

- A real server or virtual machine, its reboot, and a firewall. The server of the test was a privileged container.
- A public DNS name: Caddy obtaining certificates from Let's Encrypt, for the control plane and for an application domain. Applications were checked over HTTP on the server.
- A real SMTP provider.
- arm64 at run time, upgrading from one published release to the next, removing a server, and the released CLI against an installation.
