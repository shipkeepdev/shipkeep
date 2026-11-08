# ADR 0009: Angular for the web UI

- Status: Accepted
- Date: 2026-11-03

## Decision

- The web UI is an Angular application (latest stable), standalone components, signals, OnPush change detection.
- Styling: Tailwind CSS plus Angular CDK for accessible primitives (overlays, dialogs, tables, drag and drop).
- The UI is built to static files and served by the API process; no Node server is needed in production.
- API access only through the generated client in `packages/api-client` (from the OpenAPI document of `apps/api`).

## Consequences

- One framework the maintainers know well, strong typing end to end with the NestJS API.
- No server-side rendering; the UI is behind authentication, so SEO does not matter.
