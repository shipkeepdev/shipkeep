# ADR 0005: Caddy on every node, configured through its admin API

- Status: Accepted
- Date: 2026-11-03

## Context

Coolify generates Traefik configuration through Docker labels. Malformed labels caused 502 errors for every app across many releases. Kamal's proxy shows the right deploy contract: route to the new instance only after it is healthy, then drain the old one.

## Decision

- Each node runs Caddy as the edge proxy (automatic HTTPS, HTTP/3).
- The agent configures Caddy only through the admin API on a Unix socket, using typed JSON built from Go structs. No Caddyfile templating, no Docker labels.
- Deploys follow the switch-then-drain contract: start new instance, pass health check, add it to the route, remove the old upstream, wait for in-flight requests (drain timeout, default 30 s), stop the old instance.
- Traffic that reaches a node without a local instance is forwarded to a healthy instance on another node over WireGuard.

## Consequences

- Route changes are atomic and testable.
- DNS can point to several nodes; any node can serve any app.
