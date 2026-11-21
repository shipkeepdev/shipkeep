# ADR 0024: Metrics reach VictoriaMetrics through the control plane

- Status: Accepted
- Date: 2026-11-20
- Amends: ADR 0011

## Context

ADR 0011 runs VictoriaMetrics next to the control plane and says that agents push their metrics to it. It does not say how an agent would authenticate there, nor how one organization's series would stay apart from another's. VictoriaMetrics has no notion of tenants an agent could prove. A direct push would mean:

- publishing a new port to every server, possibly across the internet;
- giving each agent a credential for it, which it does not hold today, since agents only have their mTLS certificate for the gateway;
- trusting the labels each agent sets on its own samples, so a compromised agent could write series for another organization.

The agent already holds an authenticated stream to the control plane (SPEC 3.1). The gateway checks its certificate against the node's organization on every frame.

Caddy 2.11.9 was measured with `apps.http.metrics.per_host` enabled. Its admin endpoint exposes, for each host name of its routes, requests by status code, with the sum and count of their durations. A request with a `Host` header that matches no route added no series. A matching request is labelled with its `Host` header as sent, though: the host matcher ignores the port and accepts any text as one, so `shop.example.com:1`, `:2` and so on each made a series, and on HTTPS Caddy labels hosts outside its exact host list too, so a wildcard route would label every invented subdomain. Left as is, a client could grow Caddy's memory without limit. The bound has to come from the routes.

## Decision

The maintainer chose to send metrics through the control plane.

- **The agent samples every 30 seconds:**
  - the node: CPU in use, memory in use and in total, disk in use and in total under Docker's data root, and network bytes received and sent;
  - each managed container (`sk.managed`): CPU in use, memory in use and its limit, and network bytes received and sent;
  - each host name of its routes: requests by status class, and the sum and count of response durations, read from Caddy's `/metrics` over its admin socket. Every Shipkeep route matches the `Host` header only as its name, alone or with port 443 or 80 (`header_regexp`), so a host has at most three labels, which the agent counts as one; it adds that matcher to the routes earlier agents wrote. The agent enables `per_host` only while every route of the Shipkeep server carries that matcher and none has a wildcard host, and turns it off before writing a wildcard route: such a node reports no route metrics.
- **The agent sends a `MetricsReport` on the existing `Connect` stream.** It is a new case of `ConnectRequest`, not an action: the closed action list does not change. The report carries the session's lease epoch, at most 256 containers and 64 host names, and stays under 60 KiB like a state report. Past those bounds each sample takes the next items in name order, so every container and host name is reported at least once every ceil(count / bound) samples. A node with many routes never loses its node and container values, and no route is left out for good. Nothing is kept while the stream is down: metrics describe the past, not the desired state, and an outage shows as a gap.
- **The control plane writes the samples to VictoriaMetrics with labels it sets itself:**
  - It checks the epoch and bounds of the report, like those of a state report.
  - It maps each container name to the node's placed allocation, which gives organization, project, environment, application and replica.
  - It maps each host name to a domain whose application has a placed allocation on that node, which also gives the domain's host name as a label: route samples of two domains of one application stay apart. A host name routed only on another node of the organization is dropped, so a node cannot report traffic for another node's workload.
  - Samples that map to nothing are dropped. A label the agent sent is never written as it came.
- **VictoriaMetrics runs as a service of the control plane's Compose project:**
  - on its internal network only, with no published port;
  - pinned by digest, single-node, with 30 days of retention and its data in a volume;
  - on one machine (ADR 0021), in `shipkeep-controlplane.slice`, with a memory cap that leaves the reservation's room for PostgreSQL and the API.

  It holds no secrets. Only the API reads it.

- **The API answers metric queries.** Applications are read with `environment.read`, and servers with the permission that lists them, `node.manage`. The API builds the query from identifiers it validated for the caller's organization, so a caller cannot read another organization's series. The web UI reads the API, never VictoriaMetrics.

Logs (VictoriaLogs, ADR 0011) are not changed by this decision. Their path is decided with M6.1.

## Consequences

- No new port, credential or label of the agent's to trust. Tenant isolation rests on the gateway's identity check, as for state reports.
- The control plane is in the path of metrics. When it is down, the samples of that time are lost, and workloads and routing are unaffected (architecture rule 10). The load is one bounded frame per node every 30 seconds.
- One more service to size and to back up. It is not in the PostgreSQL backup, and losing it loses history, not state.
- `proto/` gains messages and a `ConnectRequest` case. The change is additive, and `buf breaking` passes.

## Alternatives considered

- **A direct push from the agents, as ADR 0011 said.** It needs a published port, a credential per agent, and a proxy that rewrites the labels from the agent's identity, so more moving parts for the same isolation.
- **PostgreSQL only.** Per-minute samples in a table, with no new component, in the spirit of ADR 0004. That is a heavy write load for the one stateful dependency of the control plane, and it reverses ADR 0011.
