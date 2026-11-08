# ADR 0016: Contributions under the Developer Certificate of Origin

- Status: Accepted
- Date: 2026-11-05

## Context

Shipkeep is licensed under Apache-2.0 (ADR 0010). Contributors need clear terms, with as little paperwork as possible.

## Decision

- Contributions use the Developer Certificate of Origin (DCO 1.1): every commit carries a `Signed-off-by:` line (`git commit -s`). There is no CLA. Apache-2.0 is both the inbound and the outbound license, which is enough for the hosted offering in ADR 0010.

## Consequences

- Anyone can contribute without signing an agreement. CI checks the `Signed-off-by:` line on every commit.
- If a CLA is ever needed, it must be adopted before the first external contribution that requires it. Contributions made under the DCO cannot be relicensed without their authors' consent.
