# ADR 0026: Instance backup as an encrypted export

- Status: Accepted
- Date: 2026-11-23

## Context

Losing the control plane's server loses the organizations, applications, releases, secrets and the identity of every server. The plan asks for an instance backup of the control plane's database, its certificate authority and its key-encryption key, to a separate target, restored into a fresh control plane that re-adopts the existing agents (M5.4, #231).

- The certificate authority is in the database, encrypted under the key-encryption key, like every other secret (SPEC 9).
- The key-encryption key is a file in the `keys` volume. Without it, a database backup cannot be read.
- Backup targets (M5.2) are outside the first stable version. On 2026-11-23 the maintainer chose an encrypted export kept by the operator for now, and an S3 destination after it, both in that version.

## Decision

**One archive.** It holds the database and the key-encryption key:

- It is an age file (age-encryption.org/v1), the format SPEC 10 names for backups.
- Its plaintext is a manifest line (JSON: format, version, creation time, the newest database migration of the image that made it, and the key), then a `pg_dump --format=custom` stream.
- age authenticates each chunk and the end of the stream, so a changed or cut archive is refused, not restored in part.

**Encrypted to a public key.** `backup keygen` makes an X25519 key pair:

- The public key goes in `.env` (`SHIPKEEP_BACKUP_RECIPIENT`). Creating a backup then needs no secret, which a scheduled upload to S3 will also need.
- The identity is kept off the server. Whoever holds it reads every backup and every secret in it.
- X25519 rather than age's hybrid post-quantum keys: the age tool of current distributions can then read an archive too.

**A program of the control plane image, apart from `main.js`** (`node backup.js keygen | create | restore-database | restore-key --replace-this-installation`):

- It loads neither the application nor its settings, opens no database connection, and runs with no network.
- The encryption is the `age-encryption` library (BSD-3-Clause), by the author of age, which streams.
- The key-encryption key is the one secret not encrypted with the envelope service (CLAUDE.md), because the backup is what holds it.

**`pg_dump` and `pg_restore` run in the PostgreSQL container**, the only image that carries them, as `exec`.

- `deploy/control-plane/backup.sh` connects them to the commands with pipes, so no plaintext dump is written to disk.
- The control plane process still starts no process (ARCHITECTURE).

**A restore runs in this order:**

1. It needs explicit confirmation (`replace`, or `--replace-this-installation`).
2. It stops the control plane.
3. It restores the database into a new one, `shipkeep_restore`, in one transaction. Only once it is complete does it take the name `shipkeep`; the current database is kept as `shipkeep_before_restore_<time>`. A failure leaves the current database as it was. (`pg_restore --clean` over the current database is not used: it cannot drop what the job queue's partitioned tables inherit.)
4. Only then, it replaces the key. The key it replaces is kept beside it.
5. `docker compose up -d` runs the migrations, which bring an older backup to this version, and gives the database login its grants again.

A backup from a newer version is refused: its newest migration must be one this image carries.

**S3 destination (M5.4b)**: any S3-compatible storage, set in `.env` (`SHIPKEEP_BACKUP_S3_*`).

- `backup.js upload | download | discard | list | check` run in a second container, `backup-transfer`. It has the network the storage needs, and no volume: it moves archives that are already encrypted, and never sees the key-encryption key nor anything in clear. The encrypting container keeps no network.
- `./backup.sh create --s3` pipes the dump through the encryption into a multipart upload: the archive is never a file on the server. If the pipeline fails after the upload took what it was given, the script deletes that object.
- An archive is never replaced, and `./backup.sh restore s3:NAME` fetches it into a private directory before the restore.
- HTTPS only, unless plain HTTP is said explicitly for a storage on the same machine. The requests carry the access key id, and an attacker in the path could drop a backup unseen.
- The client is the AWS SDK for JavaScript (Apache-2.0), which speaks to every S3-compatible storage. Retention is left to the storage's lifecycle rules, and a schedule to cron, which INSTALL.md shows.

## Consequences

- The agents keep their certificates, and the restored database holds the same certificate authority and server identities. Once the domain points to the new machine, they reconnect without being enrolled again.
- The operator copies archives off the server or sends them to S3, and keeps the identity somewhere else again.
- Sessions, metrics (VictoriaMetrics) and Caddy's certificates are not in the archive. Sessions are in the database and come back; the rest is history or obtained again.
- `.env` is not in the archive. A fresh installation has its own passwords, and the SMTP settings are typed again.
