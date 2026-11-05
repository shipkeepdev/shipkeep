# ADR 0016: Apache-2.0 from now, publication when the maintainer decides

- Status: Accepted
- Date: 2026-11-05
- Amends: ADR 0010

## Context

ADR 0010 planned to keep the repository private until v1.0 and to publish it under Apache-2.0 at that point. On 2026-11-05 the maintainer confirmed that Shipkeep will be open source, and asked to keep the repository private for now. Without a license file, nobody may legally contribute or reuse the code, even invited collaborators.

## Decision

- The code is licensed under Apache-2.0 from now on. `LICENSE` and `NOTICE` are in the repository root.
- The repository stays private until the maintainer decides to publish it. Publication is no longer tied to v1.0. Changing the visibility is the maintainer's action, never an automated one.
- Contributions use the Developer Certificate of Origin (DCO 1.1): every commit carries a `Signed-off-by:` line (`git commit -s`). There is no CLA. Apache-2.0 is both the inbound and the outbound license, which is enough for the hosted offering in ADR 0010.
- Everything else in ADR 0010 is unchanged: no source-available or proprietary folder, and all dependencies compatible with Apache-2.0 distribution.

## Consequences

- Invited collaborators can contribute under clear terms before publication.
- Before publication, follow the "Before going public" checklist in `docs/PLAN.md`.
- If a CLA is ever needed, it must be adopted before the first external contribution that requires it. Contributions made under the DCO cannot be relicensed without their authors' consent.
