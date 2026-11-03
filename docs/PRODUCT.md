# Shipkeep: Product Brief

## One-line pitch

Your own cloud on your own servers, without leaving the root key in a web panel.

## Thesis

Shipkeep is a self-hosted PaaS as simple as Coolify, but secure by design, driven by configuration in the repository, and truly multi-node. It does not try to beat Coolify on catalog size. It wins where Coolify is structurally weak: security, multi-node operation, observability and safe upgrades.

## Why now

- Heroku moved to a "sustaining engineering" model on 2026-02-06 and stopped signing new Enterprise contracts. Teams are looking for alternatives.
- Coolify, the market leader (60k+ GitHub stars, v4 stable since April 2026), has a structural security problem. In January 2026, eleven critical flaws (CVSS up to 10.0) affected about 52,650 exposed instances, including one that leaked the root SSH key to low-privileged members. New host RCEs followed in June and July 2026.
- Coolify's multi-server mode is not a cluster: the same image behind your own load balancer, no Compose, no persistent storage, Swarm being removed. Real multi-server is promised for v5, not shipped.
- Dokploy, the main challenger, has a source-available `/proprietary` folder that requires a commercial agreement for production use.
- Nobody combines a UI with GitOps: Kamal keeps config in the repo but has no UI, users or databases; Coolify and Dokploy have the UI but hide state in their database.

## Target users

| Segment | Situation | Pain today | Priority |
| --- | --- | --- | --- |
| Agencies and freelancers | Apps for several clients on 2 to 10 VPS | No fine isolation per client; Coolify Cloud charges one subscription per team | 1 |
| Small SaaS teams | One product in production, 2 to 20 devs, no dedicated ops | No failover, logs and alerts to assemble, risky upgrades | 1 |
| Sovereignty-driven companies and public sector | Mandatory local hosting, security audits | SSO only in a release candidate, CVE history hard to defend in an audit | 2 |
| Homelab and solo devs | Personal projects | Little pain; Coolify is enough | Not a paid target |

## Positioning

For teams that run production on their own servers, Shipkeep is the self-hosted PaaS that combines Coolify's simplicity, Kamal's versioned configuration and real multi-node operation, with security designed in from the start. Unlike Coolify, no panel holds an SSH root key and nothing runs by concatenating shell commands.

## Product principles

1. **Secure by design.** Outbound mTLS agent, typed actions, no stored SSH keys, rootless builds.
2. **Config in the repo.** `shipkeep.yml` per app, written back by the UI as a commit or PR.
3. **Real multi-node.** Placement, health checks, failover, private network, without Kubernetes.
4. **Safe upgrades.** Stable and LTS channels, automatic snapshot before upgrade, control plane rollback.
5. **Observability included.** Searchable logs and 30-day metrics with alerts.
6. **Controlled previews.** TTL, quota, empty or cloned database per PR, automatic cleanup.
7. **Light footprint.** Agent under 50 MB RAM, control plane under 500 MB.
8. **Isolated teams and clients.** Organizations, projects, environments, roles per project and environment in the free version.

Not a goal: beating Coolify's catalog. Coolify templates are Apache-2.0 Compose files; Shipkeep imports them with attribution, and imports whole Coolify instances. The migration tool is the main acquisition lever.

## Business model

| Offer | Shipkeep |
| --- | --- |
| Self-hosted | Code closed until v1, then free under Apache-2.0 with no exceptions |
| Shipkeep Cloud (hosted control plane) | Per-server price in the same range as Coolify Cloud (USD 5/month for 2 servers + 3 per server) and Dokploy Cloud (USD 4.50/server), with unlimited organizations and clients |
| Enterprise | SAML SSO, audit export, white label, LTS channel with SLA, priority support, annual contract |
| Services | Migration from Coolify or Heroku and security audits, fixed price |

## Success criteria

- MVP exit: three external teams run at least one production app for 30 days without our intervention.
- v1: external security audit passed; code published under Apache-2.0.

## Risks

| Risk | Mitigation |
| --- | --- |
| Coolify v5 ships real multi-server | Lead on security and GitOps, which v5 does not target |
| Shipkeep becomes a target | External audit before v1, responsible disclosure from v0.1, fuzzing, no shell commands |
| Small catalog | Import Coolify templates with attribution |
| Solo founder | Structured code and documented architecture so contributors can join at v1 |
| Low cloud price | Services revenue early; Enterprise and LTS as the real model |
| Two languages | Agent deliberately small and stable; business logic in the control plane |
