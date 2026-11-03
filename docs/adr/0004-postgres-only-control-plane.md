# ADR 0004: PostgreSQL as the only stateful dependency of the control plane

- Status: Accepted
- Date: 2026-11-03

## Context

Coolify's control plane needs Laravel, PostgreSQL and Redis and idles around 1.5 to 2 GB of RAM. Every extra stateful component is one more thing to back up, upgrade and secure.

## Decision

- The control plane depends on PostgreSQL 17 only.
- Background jobs and scheduling use `pg-boss` (queue on PostgreSQL), not Redis.
- Real-time UI updates use Server-Sent Events fed by PostgreSQL `LISTEN/NOTIFY`.
- ORM: Prisma, with migrations reviewed in PRs. Raw SQL only inside repositories, never in handlers.
- Target: control plane (API + web served as static files + Postgres) under 500 MB RAM at idle.

## Consequences

- Backup of the control plane is one `pg_dump` plus the CA and encryption key files, executed by the agent of the control plane node (`DumpDatabase`), never by the NestJS process.
- High availability in v1 is a stateless API behind a load balancer plus a PostgreSQL primary and replica, without a custom consensus layer.
