# ADR 0001: Monorepo with Nx for TypeScript and a Go workspace

- Status: Accepted
- Date: 2026-11-03

## Context

Shipkeep has a NestJS API, an Angular UI, shared TypeScript packages, a Go agent and a Go CLI. All of them depend on two contracts: the protobuf definitions and the `shipkeep.yml` JSON Schema. Splitting them across repositories would let the contracts drift.

## Decision

- One repository.
- Nx manages the TypeScript projects (`apps/api`, `apps/web`, `packages/*`). Nx has first-class support for both Angular and NestJS and gives affected-only builds and tests in CI.
- pnpm workspaces for dependencies.
- A Go workspace (`go.work`) at the root covers three modules: `agent/`, `cli/` and `lib/` (shared code). There is no root Go module, so Go commands always name the modules: `go test ./agent/... ./cli/... ./lib/...`. Nx runs Go targets through `nx:run-commands` so `nx affected` includes them.
- `buf` generates TypeScript code from `proto/` into `packages/proto-ts` and Go code into `lib/gen`. The CLI does not use gRPC (it talks to the REST API), but `lib/config` (shipkeep.yml types and validator) is shared by the agent, the CLI and the fuzz tests.

## Consequences

- One PR can change a contract and both sides of it atomically.
- CI must run both the Nx pipeline and the Go pipeline.
- Generated code is committed so that `go build` works without the generator installed; CI checks it is up to date (`pnpm gen && git diff --exit-code`).
