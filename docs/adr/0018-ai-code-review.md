# ADR 0018: CodeRabbit as an optional review assistant

- Status: Accepted
- Date: 2026-11-07

## Context

The owner asked for an automated reviewer on pull requests. GitHub Actions is currently unavailable, and CodeRabbit runs on its own servers, so it does not depend on it.

## Decision

- CodeRabbit may be installed on the `shipkeepdev` organization, limited to this repository, by the owner.
- `.coderabbit.yaml` skips generated code and points reviews at the architecture rules.
- It gives advice only. It is not a required check, and it replaces neither the local gate, CI, nor human review of security-sensitive changes.

## Consequences

- Pull request diffs and repository content go to a third party while the repository is private. Nothing committed may be secret anyway (`CLAUDE.md`, "Never commit"), but unreleased code leaves GitHub.
- CodeRabbit is free for public repositories. While this one is private, it needs a trial or a paid plan, which is the owner's decision.
- Removing it means uninstalling the GitHub App. The configuration file then has no effect.
