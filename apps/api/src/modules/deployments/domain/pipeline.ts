import type { ShipkeepConfig } from '@shipkeep/config-schema';
import { isFinished, type RoutingOutcome } from '@shipkeep/domain';

import {
  type ContainerPlan,
  containerName,
  containerPlan,
  durationMs,
  environmentNetwork,
  type HealthPlan,
  healthPlan,
} from './container-plan';
import type { DeploymentRecord } from './release';

/** One replica of the release on a node (SPEC 4 `Allocation`), placed before it starts. */
export interface Allocation {
  readonly index: number;
  readonly nodeId: string;
  readonly container: string;
  /** Port its release listens on (`run.port`), so routes can be restored to older releases. */
  readonly port: number;
}

/** Agent action states as the control plane records them (M1.4a2). */
export type StepState =
  | 'queued'
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'compensating'
  | 'compensated'
  | 'expired';

/** What the pipeline observed for one of its agent actions. */
export interface StepOutcome {
  readonly state: StepState;
  readonly containerId?: string;
  readonly healthy?: boolean;
  readonly exitCode?: number;
  readonly error?: string | null;
}

export interface PipelineContext {
  readonly deployment: DeploymentRecord;
  readonly application: {
    readonly id: string;
    readonly name: string;
    readonly environmentId: string;
  };
  readonly release: {
    readonly id: string;
    readonly number: number;
    /** Digest-pinned image, once resolved (M3.4c2). */
    readonly pinnedImage: string | null;
    readonly config: ShipkeepConfig;
  };
  /** Replicas of this release, once placed. */
  readonly allocations: readonly Allocation[];
  /** Replicas of the release currently serving; drained once the switch succeeded. */
  readonly previous: readonly Allocation[];
  /** Outcomes of this deployment's agent actions, by idempotency key. */
  readonly steps: ReadonlyMap<string, StepOutcome>;
}

/** An agent action the pipeline needs, keyed for idempotent enqueueing (one per node and key). */
export type PipelineStep = { readonly key: string; readonly nodeId: string } & (
  | { readonly kind: 'ensure_network'; readonly network: string }
  | { readonly kind: 'pull_image'; readonly image: string }
  | {
      readonly kind: 'run_release_task';
      readonly container: ContainerPlan;
      readonly timeoutMs: number;
    }
  | { readonly kind: 'create_container'; readonly container: ContainerPlan }
  | { readonly kind: 'start_container'; readonly containerId: string }
  | {
      readonly kind: 'health_check';
      readonly containerId: string;
      readonly health: HealthPlan;
      readonly deadlineMs: number;
    }
  | {
      readonly kind: 'upsert_route';
      readonly routeId: string;
      readonly hosts: readonly string[];
      readonly upstreams: readonly { readonly container: string; readonly port: number }[];
      readonly drainMs: number;
    }
  | { readonly kind: 'remove_route'; readonly routeId: string; readonly drainMs: number }
  | { readonly kind: 'stop_container'; readonly container: string; readonly timeoutMs: number }
  | { readonly kind: 'remove_container'; readonly container: string }
);

export type PipelineDecision =
  | { readonly kind: 'done' }
  /** Resolve the release image to a digest and record it (M3.4c2). */
  | { readonly kind: 'resolve_image' }
  /** Place this many replicas and store the allocations (SPEC 6). */
  | { readonly kind: 'place'; readonly replicas: number }
  /** Enqueue these actions (already-enqueued keys are no-ops); no steps means wait. */
  | { readonly kind: 'run'; readonly steps: readonly PipelineStep[] }
  /** The current stage is complete: move the aggregate to its next state. */
  | { readonly kind: 'advance' }
  | { readonly kind: 'fail'; readonly reason: string };

type Progress =
  | { readonly status: 'done' }
  | { readonly status: 'pending'; readonly steps: readonly PipelineStep[] }
  | { readonly status: 'failed'; readonly reason: string };

const IN_FLIGHT: ReadonlySet<StepState> = new Set(['queued', 'pending', 'running']);
const MAX_DRAIN_MS = 5 * 60_000;
const STOP_TIMEOUT_MS = 10_000;
const HEALTH_GRACE_MS = 2 * 60_000;
const MAX_HEALTH_DEADLINE_MS = 30 * 60_000;
const DEFAULT_RELEASE_TIMEOUT_MS = 10 * 60_000;

/**
 * The next thing a deployment needs (SPEC 5.1), as a pure function of what was observed. The
 * worker applies the decision and calls it again whenever an action finishes, so every stage is
 * resumable after a restart and a failure at any point stops before routing changes.
 */
export function plan(context: PipelineContext): PipelineDecision {
  const { deployment, release } = context;
  if (isFinished(deployment.state)) return { kind: 'done' };
  const failure = failedStep(context);
  if (failure) return { kind: 'fail', reason: failure };
  switch (deployment.state) {
    case 'queued':
      return release.pinnedImage ? { kind: 'advance' } : { kind: 'resolve_image' };
    case 'building':
    case 'built':
      return { kind: 'fail', reason: 'Builds are not supported yet.' };
    case 'releasing':
      return decide(context, releaseTask(context));
    case 'scheduling':
      return context.allocations.length ? { kind: 'advance' } : place(context);
    case 'starting':
      return decide(context, all(context.allocations.map((a) => replica(context, a))));
    case 'health_checking':
      return decide(context, all(context.allocations.map((a) => health(context, a))));
    case 'switching':
      return decide(context, switchRoutes(context));
    case 'draining':
      return decide(context, drain(context));
    default:
      return { kind: 'done' };
  }
}

/**
 * Best-effort cleanup after a failure (SPEC 5.1): restore the previous upstreams when the switch
 * was interrupted, and remove the new replicas unless they already serve traffic.
 */
export function recovery(context: PipelineContext, routing: RoutingOutcome): PipelineStep[] {
  if (routing === 'new_release_serving') return [];
  const steps: PipelineStep[] = [];
  const hosts = domains(context.release.config);
  if (routing === 'restore_previous' && hosts.length) {
    const previous = byNode(context.previous);
    for (const [nodeId, replicas] of previous)
      steps.push({
        kind: 'upsert_route',
        key: key(context, `restore:${nodeId}`),
        nodeId,
        routeId: context.application.id,
        hosts,
        upstreams: replicas.map((replica) => ({
          container: replica.container,
          port: replica.port,
        })),
        drainMs: 0,
      });
    // Nodes that only host new replicas lose the route the interrupted switch may have added.
    for (const nodeId of byNode(context.allocations).keys())
      if (!previous.has(nodeId))
        steps.push({
          kind: 'remove_route',
          key: key(context, `unroute-new:${nodeId}`),
          nodeId,
          routeId: context.application.id,
          drainMs: 0,
        });
  }
  for (const allocation of context.allocations)
    if (
      context.steps.get(key(context, `create:${String(allocation.index)}`))?.state === 'succeeded'
    )
      // These replicas never served traffic, so a forced removal loses nothing.
      steps.push({
        kind: 'remove_container',
        key: key(context, `cleanup:${String(allocation.index)}`),
        nodeId: allocation.nodeId,
        container: allocation.container,
      });
  return steps;
}

function decide(context: PipelineContext, progress: Progress | PipelineDecision): PipelineDecision {
  if ('kind' in progress) return progress;
  if (progress.status === 'failed') return { kind: 'fail', reason: progress.reason };
  if (progress.status === 'done') return { kind: 'advance' };
  // Keep each key once: replicas on one node share its network and image pull.
  const steps = new Map(progress.steps.map((step) => [step.key, step]));
  return { kind: 'run', steps: [...steps.values()] };
}

function place(context: PipelineContext): PipelineDecision {
  return { kind: 'place', replicas: context.release.config.scale?.replicas ?? 1 };
}

function releaseTask(context: PipelineContext): Progress | PipelineDecision {
  const first = context.allocations.at(0);
  if (!first) return place(context);
  const image = context.release.pinnedImage;
  if (!image) return { status: 'failed', reason: 'The image is not resolved.' };
  return chain(context, [
    ...prepare(context, first.nodeId, image),
    {
      kind: 'run_release_task',
      key: key(context, 'task'),
      nodeId: first.nodeId,
      container: plannedContainer(
        context,
        image,
        containerName(context.application, context.release.number, 'release'),
        true,
      ),
      timeoutMs: durationMs(context.release.config.release?.timeout, DEFAULT_RELEASE_TIMEOUT_MS),
    },
  ]);
}

function replica(context: PipelineContext, allocation: Allocation): Progress {
  const image = context.release.pinnedImage;
  if (!image) return { status: 'failed', reason: 'The image is not resolved.' };
  const create = key(context, `create:${String(allocation.index)}`);
  const prepared = chain(context, [
    ...prepare(context, allocation.nodeId, image),
    {
      kind: 'create_container',
      key: create,
      nodeId: allocation.nodeId,
      container: plannedContainer(context, image, allocation.container, false),
    },
  ]);
  if (prepared.status !== 'done') return prepared;
  const containerId = context.steps.get(create)?.containerId;
  if (!containerId) return { status: 'failed', reason: 'The agent returned no container id.' };
  return chain(context, [
    {
      kind: 'start_container',
      key: key(context, `start:${String(allocation.index)}`),
      nodeId: allocation.nodeId,
      containerId,
    },
  ]);
}

function health(context: PipelineContext, allocation: Allocation): Progress {
  const probe = healthPlan(context.release.config);
  if (!probe) return { status: 'done' };
  const containerId = context.steps.get(
    key(context, `create:${String(allocation.index)}`),
  )?.containerId;
  if (!containerId) return { status: 'failed', reason: 'The agent returned no container id.' };
  return chain(context, [
    {
      kind: 'health_check',
      key: key(context, `health:${String(allocation.index)}`),
      nodeId: allocation.nodeId,
      containerId,
      health: probe,
      deadlineMs: Math.min(probe.startPeriodMs + HEALTH_GRACE_MS, MAX_HEALTH_DEADLINE_MS),
    },
  ]);
}

function switchRoutes(context: PipelineContext): Progress {
  const hosts = domains(context.release.config);
  if (!hosts.length) return { status: 'done' };
  return all(
    [...byNode(context.allocations)].map(([nodeId, replicas]) =>
      chain(context, [
        {
          kind: 'upsert_route',
          key: key(context, `route:${nodeId}`),
          nodeId,
          routeId: context.application.id,
          hosts,
          upstreams: replicas.map((replica) => ({
            container: replica.container,
            port: replica.port,
          })),
          drainMs: drainMs(context),
        },
      ]),
    ),
  );
}

function drain(context: PipelineContext): Progress {
  const serving = new Set(
    domains(context.release.config).length ? context.allocations.map((a) => a.nodeId) : [],
  );
  const routes = [...byNode(context.previous).keys()]
    .filter((nodeId) => !serving.has(nodeId))
    .map((nodeId) =>
      chain(context, [
        {
          kind: 'remove_route',
          key: key(context, `unroute:${nodeId}`),
          nodeId,
          routeId: context.application.id,
          drainMs: drainMs(context),
        },
      ]),
    );
  const stops = context.previous.map((replica) =>
    chain(context, [
      {
        kind: 'stop_container',
        key: key(context, `stop:${replica.container}`),
        nodeId: replica.nodeId,
        container: replica.container,
        timeoutMs: STOP_TIMEOUT_MS,
      },
      // Stopped replicas would pile up on disk; a rollback deploys new containers anyway.
      {
        kind: 'remove_container',
        key: key(context, `remove:${replica.container}`),
        nodeId: replica.nodeId,
        container: replica.container,
      },
    ]),
  );
  return all([...routes, ...stops]);
}

/** The first step without a final outcome: missing ones are enqueued, running ones awaited. */
function chain(context: PipelineContext, steps: readonly PipelineStep[]): Progress {
  for (const step of steps) {
    const outcome = context.steps.get(step.key);
    if (!outcome) return { status: 'pending', steps: [step] };
    if (outcome.state !== 'succeeded') return { status: 'pending', steps: [] };
  }
  return { status: 'done' };
}

function all(progress: readonly Progress[]): Progress {
  const failed = progress.find((entry) => entry.status === 'failed');
  if (failed) return failed;
  const pending = progress.filter((entry) => entry.status === 'pending');
  if (!pending.length) return { status: 'done' };
  return { status: 'pending', steps: pending.flatMap((entry) => entry.steps) };
}

/** Any final, unsuccessful outcome of this deployment's actions stops it (SPEC 5.1). */
function failedStep(context: PipelineContext): string | undefined {
  const prefix = key(context, '');
  for (const [stepKey, outcome] of context.steps) {
    if (!stepKey.startsWith(prefix) || IN_FLIGHT.has(outcome.state)) continue;
    if (outcome.state === 'succeeded') {
      if (outcome.exitCode !== undefined && outcome.exitCode !== 0)
        return `The release command exited with code ${String(outcome.exitCode)}.`;
      if (outcome.healthy === false) return 'A replica did not become healthy.';
      continue;
    }
    const step = stepKey.slice(prefix.length).split(':')[0] ?? 'step';
    return `Step ${step} ${outcome.state}${outcome.error ? `: ${outcome.error}` : '.'}`;
  }
  return undefined;
}

function prepare(context: PipelineContext, nodeId: string, image: string): PipelineStep[] {
  return [
    {
      kind: 'ensure_network',
      key: key(context, `net:${nodeId}`),
      nodeId,
      network: environmentNetwork(context.application.environmentId),
    },
    { kind: 'pull_image', key: key(context, `pull:${nodeId}`), nodeId, image },
  ];
}

function plannedContainer(
  context: PipelineContext,
  image: string,
  name: string,
  task: boolean,
): ContainerPlan {
  return containerPlan({
    config: context.release.config,
    image,
    name,
    network: environmentNetwork(context.application.environmentId),
    labels: {
      'shipkeep.application': context.application.id,
      'shipkeep.release': context.release.id,
      'shipkeep.deployment': context.deployment.id,
    },
    task,
  });
}

function byNode(allocations: readonly Allocation[]): Map<string, Allocation[]> {
  const nodes = new Map<string, Allocation[]>();
  for (const allocation of [...allocations].sort((a, b) => a.index - b.index))
    nodes.set(allocation.nodeId, [...(nodes.get(allocation.nodeId) ?? []), allocation]);
  return nodes;
}

function domains(config: ShipkeepConfig): string[] {
  return [...(config.domains ?? [])];
}

function drainMs(context: PipelineContext): number {
  return Math.min(durationMs(context.release.config.deploy?.drain_timeout, 30_000), MAX_DRAIN_MS);
}

/** Idempotency key of a deployment step: `d:<deployment>:<step>` (agent grammar, ≤ 128). */
export function key(context: PipelineContext, step: string): string {
  return `d:${context.deployment.id}:${step}`;
}
