# ADR 0007: Configuration as code with shipkeep.yml

- Status: Accepted
- Date: 2026-11-03

## Context

Coolify and Dokploy keep application configuration in their own database. Migrating away, reviewing changes or reproducing an environment is hard. Kamal and Render (render.yaml) keep configuration in the repository, which makes changes reviewable and reproducible.

## Decision

- Each application is described by `shipkeep.yml` at the root of its repository (path configurable).
- The file is validated against `packages/config-schema/shipkeep.schema.json`.
- Changes made in the UI are written back as a commit or a pull request (user's choice per project). The UI shows the diff before saving.
- Secrets are never stored in the file, only referenced by name.
- If the file in the repository and the control plane state diverge, the repository wins at the next deploy, and the UI shows the drift.
- Apps without a repository (image-only, templates) store the same document in the control plane database, exportable as a file.

## Consequences

- Every config change has history and review.
- Exit is easy: the file describes the app completely, minus secrets.
