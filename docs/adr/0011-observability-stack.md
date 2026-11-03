# ADR 0011: Built-in observability with VictoriaLogs and VictoriaMetrics

- Status: Accepted
- Date: 2026-11-03

## Context

Coolify offers live logs only, a few hours of metrics and no configurable alerts. Users must add Loki or Grafana themselves.

## Decision

- Shipkeep runs VictoriaLogs and VictoriaMetrics (Apache-2.0, low footprint) as managed components next to the control plane.
- Agents read container logs through the Docker API and push them to VictoriaLogs with labels (org, project, environment, app, instance, node).
- Agents collect container and node metrics and push them to VictoriaMetrics.
- Default retention: 30 days for logs and metrics, configurable.
- Alert rules are evaluated by the control plane and sent through notification channels (email, Slack, Discord, Telegram, webhook).
- Users can also forward logs and metrics to an external OpenTelemetry endpoint.

## Consequences

- Searchable logs and alerts work out of the box.
- One more component to size: storage estimate shown in the UI.
