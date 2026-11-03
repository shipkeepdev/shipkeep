# ADR 0010: Closed until v1, then Apache-2.0 without exceptions

- Status: Accepted
- Date: 2026-11-03

## Decision

- The repository stays private until v1.0.
- At v1.0 the full codebase is published under Apache-2.0, with no source-available or proprietary folder.
- Revenue comes from the hosted control plane (Shipkeep Cloud) and Enterprise contracts (SAML, audit export, white label, LTS with SLA, priority support), not from gating core features.
- From day one the code is written as if it were public: no secrets, no internal-only shortcuts, contributor-grade docs.
- All dependencies must be compatible with Apache-2.0 distribution (see allowed licenses in CLAUDE.md).

## Consequences

- Publication at v1 is a visibility switch plus a launch, not a cleanup project.
- A clean license is a differentiator against Dokploy's source-available folder.
