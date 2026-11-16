import type { ShipkeepConfig } from '@shipkeep/config-schema';
import type { PlacementRequest, SchedulableNode } from '@shipkeep/domain';

import { observedStatus } from '../../fleet/domain/node';

import { resourceLimits } from './container-plan';

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

/** A placed, unstopped replica, as the load of its node needs it. */
export interface PlacedReplica {
  readonly nodeId: string;
  readonly applicationId: string;
  readonly releaseId: string;
  readonly cpuMillis: number;
  readonly memoryBytes: number;
}

/** The release a deployment places: the application's replicas of other releases are replaced. */
export interface ReplacingRelease {
  readonly applicationId: string;
  readonly releaseId: string;
}

/**
 * Sums placed replicas into the load of each node (SPEC 6). The replicas that the deployment of
 * `replacing` replaces reserve nothing: they stop when it succeeds, and its own replicas are
 * removed when it fails, so only one of the two releases keeps its reservation. Counting both
 * would refuse every new release of an application on a node that the application fills. They
 * still count in `applications`, which only ranks nodes for spread.
 *
 * `replicas` must come from one read: taking the replaced replicas from an earlier read could
 * free the room of replicas that were stopped in between, and so free it twice.
 */
export function nodeLoads(
  replicas: readonly PlacedReplica[],
  replacing?: ReplacingRelease,
): Map<string, NodeLoad> {
  const loads = new Map<string, NodeLoad>();
  for (const replica of replicas) {
    const current = loads.get(replica.nodeId) ?? { cpuMillis: 0, memoryBytes: 0, applications: [] };
    const replaced =
      replacing !== undefined &&
      replica.applicationId === replacing.applicationId &&
      replica.releaseId !== replacing.releaseId;
    loads.set(replica.nodeId, {
      cpuMillis: current.cpuMillis + (replaced ? 0 : replica.cpuMillis),
      memoryBytes: current.memoryBytes + (replaced ? 0 : replica.memoryBytes),
      applications: current.applications.includes(replica.applicationId)
        ? current.applications
        : [...current.applications, replica.applicationId],
    });
  }
  return loads;
}

/**
 * The placement request of an image application's replicas (SPEC 2 `scale`, `resources`). It
 * reserves the limits the containers run under, defaults included.
 */
export function placementRequest(applicationId: string, config: ShipkeepConfig): PlacementRequest {
  return {
    app: applicationId,
    architectures: ARCHITECTURES,
    resources: resourceLimits(config),
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
