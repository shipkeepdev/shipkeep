# ADR 0018: CodeRabbit as an optional review assistant

- Status: Accepted
- Date: 2026-11-07

## Context

An automated first read helps on pull requests. CodeRabbit runs on its own servers, independently of CI.

## Decision

- CodeRabbit may be installed on the `shipkeepdev` organization, limited to this repository.
- `.coderabbit.yaml` skips generated code and points reviews at the architecture rules.
- It gives advice only. It is not a required check, and it replaces neither local checks, CI, nor human review of security-sensitive changes.

## Consequences

- Pull request diffs and repository content go to a third party. Nothing committed may be secret anyway (`CLAUDE.md`, "Never commit").
- CodeRabbit is free for public repositories.
- Removing it means uninstalling the GitHub App. The configuration file then has no effect.
