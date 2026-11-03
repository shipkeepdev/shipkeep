# ADR 0002: Outbound mTLS agent with a closed list of typed actions

- Status: Accepted
- Date: 2026-11-03

## Context

Coolify's control plane stores root SSH keys for every server and runs shell commands built from user input. In 2026 this produced repeated critical CVEs: command injection through git source fields, the `network` parameter, Sentinel tokens and Docker Compose content, and a leak of the root SSH private key to low-privileged members. One flaw in the panel compromises every server.

## Decision

- Each server runs `shipkeep-agent`. The agent opens one outbound gRPC connection over mTLS to the control plane and keeps a bidirectional stream. No inbound port is needed on servers for control traffic.
- Enrollment uses a one-time join token (valid 15 minutes, single use). The agent generates its key pair locally and sends a CSR. The control plane's internal CA signs a client certificate valid 30 days, rotated automatically at 2/3 of its life.
- The control plane never stores SSH keys.
- The agent executes only the actions defined in `proto/shipkeep/agent/v1/actions.proto`. There is no "run command" action and no host shell. Container exec sessions exist as a typed action, are RBAC-checked and audited.
- The agent validates every field of every action itself (defense in depth), even though the control plane validated it first.

## Consequences

- Removes the most damaging class of Coolify vulnerabilities by construction.
- Adding a capability means changing the contract, which forces review.
- Servers behind NAT work without port forwarding.
- The agent becomes security-critical code: high test coverage and fuzzing are mandatory (see THREAT_MODEL).
