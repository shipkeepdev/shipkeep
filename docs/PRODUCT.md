# Shipkeep: Product Brief

## One-line pitch

Your own cloud on your own servers, without leaving the root key in a web panel.

## Thesis

Shipkeep is a self-hosted platform as simple as the tools people already use for this, but secure by design, driven by configuration in the repository, and truly multi-node. It does not compete on catalog size. It focuses on security, multi-node operation, observability and safe upgrades.

## Target users

| Segment                                        | Situation                                                 | What they need                                        |
| ---------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| Agencies and freelancers                       | Apps for several clients on 2 to 10 VPS                   | Fine isolation per client                             |
| Small SaaS teams                               | One product in production, 2 to 20 devs, no dedicated ops | Failover, logs and alerts in one place, safe upgrades |
| Sovereignty-driven companies and public sector | Mandatory local hosting, security audits                  | SSO, an audit trail and a design that passes an audit |
| Homelab and solo devs                          | Personal projects                                         | A simple way to run their own services                |

## Positioning

For teams that run production on their own servers, Shipkeep combines the simplicity of a web panel, versioned configuration and real multi-node operation, with security designed in from the start: no panel holds an SSH root key, and nothing runs by concatenating shell commands.

## Product principles

1. **Secure by design.** Outbound mTLS agent, typed actions, no stored SSH keys, rootless builds.
2. **Config in the repo.** `shipkeep.yml` per app, written back by the UI as a commit or PR.
3. **Real multi-node.** Placement, health checks, failover, private network, without Kubernetes.
4. **Safe upgrades.** Stable and LTS channels, automatic snapshot before upgrade, control plane rollback.
5. **Observability included.** Searchable logs and 30-day metrics with alerts.
6. **Controlled previews.** TTL, quota, empty or cloned database per PR, automatic cleanup.
7. **Light footprint.** Agent under 50 MB RAM, control plane under 500 MB.
8. **Isolated teams and clients.** Organizations, projects, environments, roles per project and environment in the free version.

Not a goal: beating Coolify's catalog. Coolify templates are Apache-2.0 Compose files; Shipkeep imports them with attribution, and imports whole Coolify instances.

## License

Shipkeep is free software under Apache-2.0, with no exceptions and no proprietary folder.

## Success criteria

- First release: three external teams run at least one production application for 30 days without our intervention.
- v1: external security audit passed.
