# Kickoff prompts for Claude Code

Paste these prompts into Claude Code, one session per step. Each one is self-contained.

## 1. Repository and GitHub setup

```text
Read CLAUDE.md and docs/GITHUB_SETUP.md fully.
Run sections 2, 3 and 4 of docs/GITHUB_SETUP.md with OWNER=samuelmbabhazi and REPO=shipkeep.
Do not run section 5 (branch protection) yet: it is applied after task M0.2 is merged.
Push the current files as the initial commit on main.
Do not set any secret values. When done, list what you ran, what succeeded,
and anything that failed or needs my action (sections 1, 6 and 7).
```

## 2. First milestone

```text
Read CLAUDE.md, then docs/PRODUCT.md, docs/ARCHITECTURE.md, docs/SPEC.md,
docs/THREAT_MODEL.md, docs/PLAN.md and every ADR in docs/adr/.
Create the GitHub issues for milestone M0 as described in docs/GITHUB_SETUP.md section 4.
Then implement task M0.1 on its own branch and open a PR that follows the PR template.
Stop after the PR is open and CI has run; report the CI result.
```

## 3. Every following task

```text
Read CLAUDE.md. Take the next task in docs/PLAN.md whose dependencies are merged
(tell me which one before starting). Implement it on its own branch, with tests,
following the definition of done. Open the PR, wait for CI, fix failures,
then stop and summarize what changed, how it was tested and any open question.
```

## Rules of thumb

- One task per session keeps context focused and PRs small.
- Review and merge each PR yourself before starting the next dependent task.
- If Claude Code asks for a decision not covered by an ADR, answer it and ask Claude Code to record it as a new ADR in the same PR.
