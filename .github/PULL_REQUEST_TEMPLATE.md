## Task

<!-- [M1.3] Operation journal and local state. Link the issue: Closes #123 -->

## What changed

## Why

## How it was tested

## Security considerations

<!-- Does this touch the agent, authentication, secrets, builds, RBAC or the action catalogue? If yes, explain the impact and add the `security-review` label. -->

## Checklist

- [ ] Acceptance criteria from `docs/PLAN.md` are met and the task is ticked
- [ ] Lint, TS tests, Go tests and `buf lint` pass
- [ ] Tests added, including malicious-input tests where relevant
- [ ] No new shell invocation and no new secret exposure path
- [ ] Audit events emitted for new state changes
- [ ] SPEC, ARCHITECTURE, THREAT_MODEL or an ADR updated if a contract or decision changed
