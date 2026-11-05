# ADR 0017: Route upstreams that name a local container

- Status: Accepted
- Date: 2026-11-05

## Context

Caddy runs on each node's host (ADR 0005) and proxies to containers on Shipkeep Docker networks. `UpsertRoute` accepted only private `IP:port` literals. Nothing in the protocol tells the control plane a container's address: `CreateContainer` returns an id, and `StateReport` carries no addresses. Docker also does not promise that a container keeps its address across restarts, and the agent restarts containers on its own during reconciliation (SPEC 3.5).

The deployment pipeline (PLAN M3.4c) needs to switch a route to the containers it just started.

## Decision

- `Upstream` gains an alternative to `address`: `container` (a managed container name, `^sk-[a-z0-9-]{1,60}$`) with `port` (1 to 65535). Exactly one form is set per upstream.
- The agent resolves the container when it applies the route:
  - the container must exist, carry `sk.managed=true` and be running;
  - its address comes from the first `sk-` network, by name order, and must be a private IP;
  - the result is the Caddy dial address.
  - Resolution failures fail the action (retry-safe), and nothing changes in Caddy.
- Upstreams on other nodes keep using `address` with WireGuard addresses (M4.4).

## Consequences

- The control plane never needs container IPs, and a container restart is handled locally.
- The action list is unchanged. The new input is validated by the agent, with malicious-input tests, and grants no new reach: only managed containers on Shipkeep networks, at private addresses.
- If a container's address changes after the route was applied, the route keeps the old address until the next `UpsertRoute`. Re-applying routes during reconciliation is left to M1.6 and M4.4.
