# Installing Shipkeep

> **Status: not yet verified on a real server.** The image, the compose file and each step below were exercised piece by piece (see [What has been tested](#what-has-been-tested)), but nobody has run the whole procedure on a fresh machine yet, and no release has been published. Treat this page as the procedure under test, and please [report](https://github.com/shipkeepdev/shipkeep/issues) where it breaks.

A Shipkeep installation has two kinds of machines:

- **One control plane**: the web UI, the API and PostgreSQL. Installed with Docker Compose, below.
- **One or more servers** that run your applications. Each runs the Shipkeep agent, which connects out to the control plane. Their installer is still a draft ([#171](https://github.com/shipkeepdev/shipkeep/pull/171)).

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

- The image contents, assembled by hand without Docker: production dependencies, migrations and the restricted login against PostgreSQL 18, then the control plane in production mode serving the API and the web UI.
- The image build itself, by the `release` workflow in dry-run mode.
- The provisioning script and the configuration parsing, by automated tests.

Not tested yet: `docker compose up` as a whole, Caddy obtaining a certificate, an agent enrolling against this installation, and a deployment.
