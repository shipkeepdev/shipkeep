# Installing Shipkeep

> **Status: exercised locally, not yet on a public server.** The whole procedure has run on one machine with Docker (see [What has been tested](#what-has-been-tested)): the control plane, a server installed with the command from the Servers page, deployments and a rollback. A real server, a public certificate and a real mail provider have not been tried. Please [report](https://github.com/shipkeepdev/shipkeep/issues) where it breaks.

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

1. Get the three files of [`deploy/control-plane`](../deploy/control-plane): `compose.yml`, `Caddyfile` and `.env.example`. Put them in one directory, for example `/opt/shipkeep`.
2. Copy `.env.example` to `.env` and fill it in. Keep the file private: `chmod 600 .env`.
   - `SHIPKEEP_IMAGE` is the release, by tag **and digest**, as printed in its release notes. You can check that the image was built by this repository's release workflow:

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

On one machine with Docker Engine 29 and Compose 2.40, on 12 November 2026, from an image built from this repository at the commit of the first release, starting from nothing each time:

- `docker compose up -d`: the three one-shot steps exit 0, the control plane becomes healthy and answers over HTTPS through Caddy (with Caddy's internal certificate authority, since the test name was not public).
- Restarting the control plane, restarting Caddy, and the control plane process exiting on its own: the site answers again each time without manual action.
- Sign-up with the confirmation email (a local mail server with implicit TLS), sign-in, an organization, a project and an environment.
- The install command copied from the Servers page, run in an Ubuntu 24.04 container with systemd: it exits 0, Docker and Caddy are installed, the agent enrolls, the server shows as `ready` and the token file is removed. With a wrong checksum it reports the mismatch, runs nothing and exits 1. On a server already installed it refuses and exits 1.
- Deployments of public images written as `owner/image`, `docker.io/owner/image`, `index.docker.io/owner/image`, `nginx` and `docker.io/library/nginx`: network, pull by digest, container, health check, route, state `succeeded`, and the application answering through the server's Caddy.
- A second deployment replacing the first, then a rollback to the first release.
- On the server: restarting Caddy and killing it with `kill -9` (the route keeps serving and the admin socket keeps mode 0660, with no TCP admin listener), restarting the agent (it reconnects), then a new deployment.

Not tested yet:

- A real server or virtual machine: a reboot, a firewall, and Docker storage as on a normal host. The server of the test was a privileged container.
- A public DNS name: Caddy obtaining certificates from Let's Encrypt, for the control plane and for an application domain. Applications were checked over HTTP on the server.
- A real SMTP provider.
- arm64 at run time, upgrading from one published release to the next, and removing a server.
