import type { ShipkeepConfig } from '@shipkeep/config-schema';
import type { PlacementRequest, SchedulableNode } from '@shipkeep/domain';

import { observedStatus } from '../../fleet/domain/node';

import { cpuMillis, sizeBytes } from './container-plan';

/** What placement needs from a node record. */
export interface NodeView {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly lastHeartbeatAt: Date | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly facts: Readonly<Record<string, string | number>>;
}

/** Placed, unstopped replicas on a node, summed for scheduling. */
export interface NodeLoad {
  readonly cpuMillis: number;
  readonly memoryBytes: number;
  readonly applications: readonly string[];
}

/**
 * Architectures accepted for image applications. The image index is resolved, not inspected, so
 * every architecture agents run on is allowed; a wrong one fails when the agent pulls or starts it.
 */
const ARCHITECTURES = ['amd64', 'arm64'] as const;

/**
 * Scheduler view of the organization's nodes (SPEC 6), keyed by node name. Capacity comes from the
 * agent's facts; a node without them has no capacity and only accepts unreserved replicas.
 * Liveness is read at `now` (SPEC 5.2), so a node whose heartbeats stopped is not ready.
 */
export function schedulableNodes(
  nodes: readonly NodeView[],
  load: ReadonlyMap<string, NodeLoad>,
  now: Date,
): SchedulableNode[] {
  return nodes
    .filter((node) => node.status !== 'removed')
    .map((node) => {
      const used = load.get(node.id);
      return {
        name: node.name,
        status: observedStatus(
          {
            status: node.status as Parameters<typeof observedStatus>[0]['status'],
            lastHeartbeatAt: node.lastHeartbeatAt,
          },
          now,
        ),
        architecture:
          typeof node.facts['architecture'] === 'string' ? node.facts['architecture'] : '',
        labels: node.labels,
        capacity: {
          cpuMillis: wholeNumber(node.facts['cpu_count']) * 1000,
          memoryBytes: wholeNumber(node.facts['memory_bytes']),
        },
        reserved: { cpuMillis: used?.cpuMillis ?? 0, memoryBytes: used?.memoryBytes ?? 0 },
        // Replicas expose ports on Docker networks only; nothing binds host ports.
        usedPorts: [],
        apps: used?.applications ?? [],
        volumes: [],
      };
    });
}

/** The placement request of an image application's replicas (SPEC 2 `scale`, `resources`). */
export function placementRequest(applicationId: string, config: ShipkeepConfig): PlacementRequest {
  return {
    app: applicationId,
    architectures: ARCHITECTURES,
    resources: {
      cpuMillis: cpuMillis(config.resources?.cpu),
      memoryBytes: sizeBytes(config.resources?.memory),
    },
    labels: Object.fromEntries(
      Object.entries(config.scale?.placement?.labels ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    ports: [],
    spread: config.scale?.placement?.spread ?? 'node',
    nodes: config.scale?.placement?.nodes ?? [],
  };
}

function wholeNumber(value: string | number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
