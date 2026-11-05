import { InvalidInputError } from './errors.js';

/** Resource amounts in whole millicores and bytes. */
export interface Resources {
  readonly cpuMillis: number;
  readonly memoryBytes: number;
}

/** What the scheduler needs to know about a node (SPEC 6); built from current node state. */
export interface SchedulableNode {
  readonly name: string;
  readonly status: string;
  readonly architecture: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly capacity: Resources;
  /** Sum of reservations of workloads already placed on the node. */
  readonly reserved: Resources;
  readonly usedPorts: readonly number[];
  /** Apps with at least one replica on the node. */
  readonly apps: readonly string[];
  /** Volumes stored on the node. */
  readonly volumes: readonly string[];
}

export interface PlacementRequest {
  readonly app: string;
  /** Architectures the image is published for. */
  readonly architectures: readonly string[];
  readonly resources: Resources;
  /** Labels the node must carry with exactly these values. */
  readonly labels: Readonly<Record<string, string>>;
  /** Host ports the replica binds. */
  readonly ports: readonly number[];
  readonly spread: 'node' | 'none';
  /** Optional allow-list of node names (`placement.nodes`). Empty means any node. */
  readonly nodes: readonly string[];
  /** Stateful workloads: pinned to the node that stores this volume, if any node does. */
  readonly volume?: string;
}

export type PlacementRejection =
  'not_ready' | 'architecture' | 'labels' | 'not_allowed' | 'cpu' | 'memory' | 'ports' | 'volume';

export type PlacementDecision =
  | { readonly placed: true; readonly node: string }
  | {
      readonly placed: false;
      /** Why each node was rejected, by node name, for operator explanations. */
      readonly rejections: Readonly<Record<string, PlacementRejection>>;
    };

/**
 * SPEC 6 placement of one replica. Pure and deterministic: the result depends only on the
 * values given, never on the order of `nodes`.
 */
export function placeReplica(
  request: PlacementRequest,
  nodes: readonly SchedulableNode[],
): PlacementDecision {
  assertRequest(request);
  for (const node of nodes) assertNode(node);
  const names = new Set<string>();
  for (const node of nodes) {
    if (names.has(node.name)) throw invalid('Node names must be unique.');
    names.add(node.name);
  }
  const pinned =
    request.volume !== undefined &&
    nodes.some((node) => request.volume !== undefined && node.volumes.includes(request.volume));
  const rejections: Record<string, PlacementRejection> = {};
  const eligible: SchedulableNode[] = [];
  for (const node of nodes) {
    const rejection = reject(request, node, pinned);
    if (rejection) rejections[node.name] = rejection;
    else eligible.push(node);
  }
  const best = eligible.sort((a, b) => compare(request, a, b)).at(0);
  return best ? { placed: true, node: best.name } : { placed: false, rejections };
}

/**
 * Places `replicas` replicas one after another, each seeing the reservations, ports and spread of
 * the previous ones. Stops at the first replica that cannot be placed.
 */
export function placeReplicas(
  request: PlacementRequest,
  replicas: number,
  nodes: readonly SchedulableNode[],
): { readonly nodes: readonly string[]; readonly unplaced: number } {
  if (!Number.isSafeInteger(replicas) || replicas < 0 || replicas > 1000)
    throw invalid('Replicas must be an integer from 0 to 1000.');
  let state = [...nodes];
  const placed: string[] = [];
  for (let index = 0; index < replicas; index++) {
    const decision = placeReplica(request, state);
    if (!decision.placed) return { nodes: placed, unplaced: replicas - index };
    placed.push(decision.node);
    state = state.map((node) =>
      node.name === decision.node
        ? {
            ...node,
            reserved: {
              cpuMillis: node.reserved.cpuMillis + request.resources.cpuMillis,
              memoryBytes: node.reserved.memoryBytes + request.resources.memoryBytes,
            },
            usedPorts: [...node.usedPorts, ...request.ports],
            apps: node.apps.includes(request.app) ? node.apps : [...node.apps, request.app],
          }
        : node,
    );
  }
  return { nodes: placed, unplaced: 0 };
}

function reject(
  request: PlacementRequest,
  node: SchedulableNode,
  pinned: boolean,
): PlacementRejection | undefined {
  if (node.status !== 'ready') return 'not_ready';
  if (!request.architectures.includes(node.architecture)) return 'architecture';
  if (Object.entries(request.labels).some(([key, value]) => node.labels[key] !== value))
    return 'labels';
  if (request.nodes.length > 0 && !request.nodes.includes(node.name)) return 'not_allowed';
  if (pinned && request.volume !== undefined && !node.volumes.includes(request.volume))
    return 'volume';
  if (node.reserved.cpuMillis + request.resources.cpuMillis > node.capacity.cpuMillis) return 'cpu';
  if (node.reserved.memoryBytes + request.resources.memoryBytes > node.capacity.memoryBytes)
    return 'memory';
  if (request.ports.some((port) => node.usedPorts.includes(port))) return 'ports';
  return undefined;
}

function compare(request: PlacementRequest, a: SchedulableNode, b: SchedulableNode): number {
  if (request.spread === 'node') {
    const spread = Number(a.apps.includes(request.app)) - Number(b.apps.includes(request.app));
    if (spread !== 0) return spread;
  }
  return (
    ratio(
      a.reserved.memoryBytes,
      a.capacity.memoryBytes,
      b.reserved.memoryBytes,
      b.capacity.memoryBytes,
    ) ||
    ratio(a.reserved.cpuMillis, a.capacity.cpuMillis, b.reserved.cpuMillis, b.capacity.cpuMillis) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

/** Exact comparison of usedA/totalA and usedB/totalB, without floating-point rounding. */
function ratio(usedA: number, totalA: number, usedB: number, totalB: number): number {
  const left = BigInt(usedA) * BigInt(totalB);
  const right = BigInt(usedB) * BigInt(totalA);
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertRequest(request: PlacementRequest): void {
  // Widened on purpose: requests come from configuration and must be checked at runtime.
  const spread: string = request.spread;
  if (
    !request.app ||
    request.architectures.length === 0 ||
    !validResources(request.resources) ||
    !request.ports.every(validPort) ||
    new Set(request.ports).size !== request.ports.length ||
    (spread !== 'node' && spread !== 'none')
  )
    throw invalid('Invalid placement request.');
}
function assertNode(node: SchedulableNode): void {
  if (
    !node.name ||
    !validResources(node.capacity) ||
    !validResources(node.reserved) ||
    node.capacity.cpuMillis === 0 ||
    node.capacity.memoryBytes === 0 ||
    !node.usedPorts.every(validPort)
  )
    throw invalid(`Invalid scheduling state for node ${node.name || '(unnamed)'}.`);
}
function validResources(value: Resources): boolean {
  return [value.cpuMillis, value.memoryBytes].every(
    (amount) => Number.isSafeInteger(amount) && amount >= 0,
  );
}
function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
function invalid(message: string): InvalidInputError {
  return new InvalidInputError('invalid_placement', message);
}
