# ADR 0029: Logs reach VictoriaLogs through the control plane

- Status: Accepted
- Date: 2026-11-24
- Amends: ADR 0011

## Context

ADR 0011 runs VictoriaLogs next to the control plane, and says that agents read container logs through the Docker API and push them there. ADR 0024 rejected the same direct push for metrics: it needs a published port, a credential per agent, and trust in the labels each agent sets. Those reasons hold for logs, and without the private network (out of scope for v0.1.0) the port would face the internet.

Logs differ from metrics in two ways that rule out the `Connect` stream:

- **Volume.** One application can write megabytes a minute. On `Connect`, those frames would sit in front of heartbeats, which must arrive every 15 seconds, and of action updates.
- **Loss.** A metric sample lost during an outage leaves a gap, which ADR 0024 accepts. A log line is often what explains the outage, so it should come back once the control plane does.

Docker keeps each managed container's output in `json-file` files, at most three of 10 MB (SPEC 3.3). The agent can read them again from any time with `since`, as long as they have not rotated away.

## Decision

The maintainer chose a dedicated stream through the control plane.

### The stream

- `AgentGatewayService` gains `ShipLogs(stream ShipLogsRequest) returns (stream ShipLogsResponse)`. It is an RPC beside `Connect` and `ExecStream`, not an action: the closed action list does not change.
- Authentication is that of `Connect`: a client certificate and the node's registration, checked at every frame and at least once a second. The first frame carries the session's lease epoch, and a stale epoch closes the stream. One stream per node replaces its predecessor.
- The agent opens it after Welcome, when the Welcome says logs are kept (the control plane has `VICTORIALOGS_URL`). Otherwise it ships nothing. `ConfigUpdate.logs_endpoint`, from the direct push, is deprecated and never set.

### What the agent sends

- Each frame is a batch: a sequence number, then at most 256 entries and 60 KiB. An entry has the container name, `stdout` or `stderr`, Docker's timestamp and the line.
  - A line is cut at 16 KiB and marked as cut.
  - Docker's partial lines are joined up to that length.
  - Text that is not UTF-8 is replaced, byte for byte, with U+FFFD.
- The agent follows every managed container (`sk.managed`) with Docker's logs API: `follow`, `timestamps`, and `since` its cursor.
- It removes secret values from each line before sending it, as `[redacted]`. These are the values of the container's secret environment variables (`ContainerSpec.secrets`) of 8 bytes or more. It reads them from Docker's configuration of the container, and the names from its journal. Secrets mounted as files are not redacted. Neither is a value the application transforms (encoded, split or quoted).
- **Acknowledgements.**
  - The control plane acknowledges a batch by its sequence number once VictoriaLogs has accepted it.
  - At most four batches are unacknowledged at a time.
  - For each container, the agent stores the timestamp of its last acknowledged line in its local state. It is not secret.
- **After an outage or a restart,** the agent reads again from that cursor, and sends lines with a timestamp at or after it. A line can therefore arrive twice, and none is lost while it is still in Docker's files. Lines that rotated away before they were sent are lost. So are those of a container removed first, since Docker deletes its logs with it.
- Nothing is buffered outside Docker's files. Running workloads and routing never depend on the stream (CLAUDE.md rule 10).

### What the control plane writes

- **Labels.** It maps each container name to the node's placed allocation, as ADR 0024 does for metrics. That gives organization, project, environment, application, replica, node and stream. A line that maps to nothing is dropped, and the agent's own labels are never written.
- **Rate.** Each node gets 512 KiB per second, with bursts up to 4 MiB. Past that, acknowledgements wait: the agent falls behind, and drops nothing.
- **Writing.** It writes batches to VictoriaLogs' JSON lines endpoint, and acknowledges each batch only after VictoriaLogs has accepted it.
- **The VictoriaLogs service.** It is a service of the control plane's Compose project, like VictoriaMetrics:
  - on the internal network only, with no published port;
  - pinned by digest, single-node, with 30 days of retention and its data in a volume;
  - on one machine (ADR 0021), in `shipkeep-controlplane.slice`, with a memory cap.

### What users read

- The API answers searches and a live tail for one application, with `environment.read`, from VictoriaLogs' query and tail endpoints. The web UI reads the API, never VictoriaLogs.
- The API builds the LogsQL query from identifiers it validated for the caller's organization. The user's text is a quoted phrase, so it cannot change the query's filters.
- The live tail is the same search, followed. Nothing reaches the agent: the tail needs no action either.

Build output and the release command's output use the same stream and labels once builds exist (M3.3). Their details are decided with builds.

## Consequences

- No new port, credential or trusted label on the agent's side. Tenant isolation rests on the gateway's identity check, as for metrics.
- A control plane outage delays logs instead of losing them, within Docker's rotation, and duplicates can appear at the cursor.
- An application that prints a secret it received as a file, or a transformed one, exposes it to everyone who can read its logs. Redaction covers the plain case only.
- One more service to size. VictoriaLogs is not in the PostgreSQL backup: losing it loses history, not state.
- `proto/` gains an RPC and its messages. The change is additive, and `buf breaking` passes.

## Alternatives considered

- **A direct push, as ADR 0011 said.** It needs a published port, a credential per agent and label rewriting, as ADR 0024 found for metrics.
- **A `ConnectRequest` case.** It needs less code, but log volume would delay heartbeats and action updates behind it, and the 64 KiB frame cap would apply to both.
- **Redaction by the control plane.** The ingest path would then hold the decrypted secrets of every application on the node. The agent has them already, in the containers it created.
