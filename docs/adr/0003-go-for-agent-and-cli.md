# ADR 0003: Go for the agent and the CLI

- Status: Accepted
- Date: 2026-11-03

## Context

The agent runs on every user server, including small VPS with 1 to 2 GB of RAM. It must be a single file, start fast, use little memory, and talk to Docker, WireGuard and Caddy. The CLI must install with one command on Linux, macOS and Windows.

## Decision

- The agent and the CLI are written in Go and shipped as static binaries for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64 (CLI only) and windows/amd64 (CLI only).
- The agent uses the official Docker Engine Go SDK, `wgctrl` for WireGuard, Caddy's admin API over a Unix socket, and pure-Go SQLite (`modernc.org/sqlite`) for local state.
- Target: agent resident memory under 50 MB at idle on a node with 20 containers.
- The control plane stays in TypeScript (NestJS). The CLI talks to the public REST API, not to gRPC.

## Consequences

- Two languages to maintain. Mitigation: the agent stays small and dumb; business logic lives in the control plane.
- The CLI was initially planned in TypeScript; Go removes the need for a Node runtime on the user's machine and gives Homebrew and Scoop distribution for free through GoReleaser.
