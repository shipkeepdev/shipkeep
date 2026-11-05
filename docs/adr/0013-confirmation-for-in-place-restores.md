# ADR 0013: Confirmation tokens for in-place restores

- Status: Accepted
- Date: 2026-11-05

## Context

`RemoveVolume` and `RemoveContainer{remove_volumes=true}` require a confirmation token (SPEC 3.6, CLAUDE.md rule 7). `RestoreVolume` and `RestoreDatabase` did not, although a restore over an existing volume or database destroys its current contents just as surely as a deletion. Scheduled restore tests (PLAN M5.3) restore into fresh targets without a user present, so a token cannot be required for every restore.

## Decision

- `RestoreVolume` gains `confirmation_token = 4` and `RestoreDatabase` gains `confirmation_token = 6`, both `debug_redact`.
- The agent, not the control plane, decides whether a token is needed. Immediately before restoring, while holding the resource's operation lock:
  - for `RestoreVolume`, it inspects the volume through the Docker Engine API;
  - for `RestoreDatabase`, it lists the engine's databases with a fixed argv template.
- If the target exists, the token must verify under SPEC 3.6: signature, expiry, single-use `jti`, and a matching action and target. The action is `restore_volume` with the volume name as target, or `restore_database` with `<container_id>/<database>` as target.
- If the agent cannot determine whether the target exists, it treats the target as existing (fail closed).
- Restoring into a target that does not exist needs no token.

## Consequences

- An in-place restore always involves an explicit, audited human confirmation. Restore tests and "restore anywhere" into new targets stay automatic.
- The action list changed (rule 2). The implementing PR for M5.3 must carry agent validation, malicious-input tests and the `security-review` label:
  - a missing, expired, replayed or mismatched token on an existing target;
  - a target name that would collide after normalization.
- Adding fields is wire-compatible (`buf breaking` passes). No agent implements these actions yet.
