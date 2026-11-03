# ADR 0008: Failover with heartbeats, leases and fencing

- Status: Accepted
- Date: 2026-11-03

## Context

Automatic failover must never run two copies of an app that writes to a volume or a database. Nomad uses heartbeats to detect dead clients; distributed systems use leases and fencing epochs to prevent split brain.

## Decision

- Agents send a heartbeat every 5 s. A node is `suspect` after 15 s without heartbeat and `down` when its lease expires (default 60 s).
- Each node holds a lease with a monotonically increasing epoch. Every stateful allocation records the epoch under which it was started.
- Stateless allocations on a `down` node are rescheduled on healthy nodes automatically.
- Stateful allocations (volumes, databases) are never moved automatically by default. With the opt-in policy `failover: restore-from-backup`, the control plane restores the latest backup on another node only after the lease of the original node has expired.
- When an agent reconnects after a partition, it compares its epoch with the control plane. If its epoch is stale, it stops its stateful containers before doing anything else.

## Consequences

- No split brain on volumes.
- Stateful failover is slower and explicit, which is the correct trade-off for user data.
