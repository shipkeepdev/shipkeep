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
- Its plaintext is a manifest line (JSON: format, version, creation time, the newest database migration of the image that made it, the key, and a tag), then a `pg_dump --format=custom` stream.
- age authenticates each chunk and the end of the stream, so a changed or cut archive is refused, not restored in part.

**Encrypted to a public key.** `backup keygen` makes an X25519 key pair:

- The identity is kept off the server. Whoever holds it reads every backup and every secret in it.
- The server keeps a backup key in the `keys` volume, read-only: the public key, and an authentication key derived from the identity (HKDF-SHA256). Neither gives the identity back. Creating a backup needs the server's keys only, which a scheduled upload to S3 will also need.
- X25519 rather than age's hybrid post-quantum keys: the age tool of current distributions can then read an archive too.

**Authenticated by the server that made it.** age does not say who wrote an archive: anyone who knows the public key can encrypt to it. A forged archive would reach `pg_restore`, which runs its statements as the database owner, and would replace the key-encryption key. So:

- The manifest's tag is an HMAC-SHA256 of its other fields under the authentication key.
- A restore derives that key from the identity it is given, and refuses an archive whose tag does not match before a byte of it reaches `pg_restore`.
- age encrypts the whole archive under one file key, chunk by chunk, so whoever wrote the manifest wrote the rest.
- Whoever holds the identity can still make an archive that a restore accepts. That is the operator, who can read every backup anyway.
- A signature was the other option. It would need a verification key kept with the identity; a key derived from the identity needs nothing more.

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
3. It restores the database into a new one, `shipkeep_restore`, in one transaction. Only once it is complete does it take the name `shipkeep`, and the current database is kept as `shipkeep_before_restore_<time>`; both renames are one transaction. Sessions still open on the current database are ended first: the control plane is stopped, so they are connections it left behind, as when `up -d` recreates the network namespace it shares, and PostgreSQL refuses to rename a database in use. (`pg_restore --clean` over the current database is not used: it cannot drop what the job queue's partitioned tables inherit.)
4. Only then, it writes the backup key for the identity it was given, and replaces the key-encryption key. The key it replaces is kept beside it.
5. `docker compose up -d` runs the migrations, which bring an older backup to this version, and gives the database login its grants again.

A failure stops the restore, with the control plane stopped, and the script says which state it left:

- Up to and including the renames, the current database is unchanged.
- If step 4 fails, the restored database is `shipkeep`. The key file holds one whole key, never none: the installation's, or the restored one if only the last sync to disk failed. The previous key gets a second name first, and the restored key replaces it in one rename. The previous database is kept under the name the script prints. Running the restore again completes it.

A backup from a newer version is refused: its newest migration must be one this image carries.

## Consequences

- The agents keep their certificates, and the restored database holds the same certificate authority and server identities. Once the domain points to the new machine, they reconnect without being enrolled again.
- The operator copies archives off the server, and keeps the identity somewhere else again. The S3 destination that follows reuses the archive and the commands; only where the archive goes changes.
- Sessions are in the database, so they are in the archive and come back with it. Metrics (VictoriaMetrics) and Caddy's certificates are not in the archive: they are history, or obtained again.
- Running `keygen` again replaces the server's backup key for the backups that follow. Earlier archives open with the identity they were made for.
- `.env` is not in the archive. A fresh installation has its own passwords, and the SMTP settings are typed again.
