# ADR 0006: Agent local state, resumable operations and replicated routing

- Status: Accepted
- Date: 2026-11-03

## Context

Fly.io's `flyd` keeps each worker as the source of truth for what runs on it and journals operations so it can resume after restarts. Fly's proxy reads routing from Corrosion, a gossip-replicated SQLite store, so routing survives the loss of any central component. Uncloud uses the same Corrosion approach with no control plane at all.

## Decision

- Each agent stores in local SQLite: the desired state it last received, the actual state it observed, and an operation journal.
- Every action is written to the journal (state `pending`) before it starts and updated at each step. On restart the agent resumes or rolls back unfinished operations.
- The control plane computes the routing table (domain to healthy instances across nodes) and pushes it to every agent. Agents cache it and keep serving from the cache if the control plane is unreachable.
- MVP: replication goes through the control plane push. v0.5: evaluate Corrosion (Apache-2.0) for peer-to-peer replication so routing updates propagate even during a control plane outage.

## Consequences

- A control plane outage does not stop running apps or routing.
- Agent upgrades can happen during deploys without corrupting state.
- New routing changes (new deploys) need the control plane until Corrosion lands.
