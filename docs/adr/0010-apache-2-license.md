# ADR 0010: Apache-2.0 without exceptions

- Status: Accepted
- Date: 2026-11-03

## Decision

- The full codebase is licensed under Apache-2.0, with no source-available or proprietary folder. `LICENSE` and `NOTICE` are in the repository root.
- Core features are not gated.
- All dependencies must be compatible with Apache-2.0 distribution (see allowed licenses in CLAUDE.md).

## Consequences

- Anyone can use, change and redistribute the whole project under one license.
- Contributions are covered by [ADR 0016](0016-developer-certificate-of-origin.md).
