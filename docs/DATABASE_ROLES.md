# PostgreSQL runtime and migration roles

Use a dedicated Shipkeep PostgreSQL database. Migrations run as its administrator; the API uses a separate login that inherits the `shipkeep_runtime` group. Never give that login superuser, BYPASSRLS, CREATEROLE, replication, public-schema CREATE, tenant-table ownership, TRUNCATE or TRIGGER capabilities, directly or through another role. Tenant operations refuse unsafe configurations before querying tenant rows.

## Local development

Copy both PostgreSQL URLs from `.env.example`, changing their ports together when necessary. `MIGRATION_DATABASE_URL` is administrative; `DATABASE_URL` uses `shipkeep_app`. `pnpm dev` migrates first, then runs `pnpm dev:database-role` to create the restricted development login and apply grants. Existing login passwords are not changed. Existing `.env` files must be updated explicitly; the tool never rewrites them. The example password is for loopback development only.

The development tool refuses non-loopback hosts and production mode, then runs the same provisioning as a real installation, which refuses different target databases, administrative/runtime login reuse and connection-string options. It uses the PostgreSQL driver directly and emits no credential or driver diagnostic.

## Deployment and upgrades

The control plane image carries both steps: `node_modules/.bin/prisma migrate deploy --config prisma.config.ts`, then `node postgres/provision-runtime.mjs`. The second one creates the `shipkeep_app` login from the password in `DATABASE_URL` when it does not exist, applies `runtime-role.sql` and grants the group, in one transaction, and checks that the login works. It never changes an existing password, and refuses a login with elevated attributes or a membership in any other role. Connections time out after 15 seconds. For a database reached over a network that is not private to the installation, add `?sslmode=verify-full` to both URLs; no other connection option is accepted. The manual procedure below does the same by hand.

1. Supply the administrator connection only to the migration process, using `MIGRATION_DATABASE_URL`. The Prisma CLI falls back to `DATABASE_URL` for existing administrative CI fixtures; the running API never reads `MIGRATION_DATABASE_URL`.
2. Apply migrations, then run `deploy/postgres/runtime-role.sql` transactionally as the administrator, for example with `psql --single-transaction --file deploy/postgres/runtime-role.sql` and private PostgreSQL connection configuration. The script refuses an unsafe existing runtime group. It replaces that group's table grants with the explicit runtime list, leaving migration tracking tables inaccessible. Reapply it after each migration release; no default privilege grants automatically expose future tables.
3. Create a dedicated LOGIN with no elevated attributes and set a strong password privately (for example with the interactive `psql` command `\password`). Grant `shipkeep_runtime` to that login with `INHERIT TRUE, SET FALSE`. Do not grant other roles to it. Point only the API's `DATABASE_URL` at this login.
4. Verify readiness, an account flow and a tenant operation before serving traffic. Health alone checks connectivity; the tenant transaction also validates RLS and role privileges. A tenant storage-unavailable response requires checking role configuration with the administrator, never disabling RLS.

The runtime group can read/insert audit events but cannot rewrite or delete them. M2.4 still owns the remaining audit guarantees and export/UI work. pg-boss owns and migrates only `shipkeep_jobs`; the provisioning script transfers existing queue tables, sequences, views, enums/domains and routines in that schema without deleting jobs. It never transfers application tables or globally reassigns objects owned by the administrator.

Organizations must already have owners, and fleet records must reference real organizations before the corresponding migrations run. Reconcile any legacy orphan records with their verified owners; migrations do not invent a default tenant or remove orphan data.
