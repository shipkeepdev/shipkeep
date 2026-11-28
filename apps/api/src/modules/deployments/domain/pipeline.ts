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
import { type ActionReason, reasonText } from '../../fleet/domain/agent-action';

import { type DeploymentRecord, repositoryPath } from './release';

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
  /** The manifest a build pushed (ADR 0030). */
  readonly imageDigest?: string;
  /**
   * Why an unsuccessful action ended as it did, as a code. The text an agent sent never comes
   * this far: a deployment's failure message is built from the code.
   */
  readonly reason?: ActionReason | null;
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
    /** The image as the release names it: for a build, the tag it pushes (ADR 0030). */
    readonly image: string;
    /** Digest-pinned image, once resolved (M3.4c2) or built. */
    readonly pinnedImage: string | null;
    readonly config: ShipkeepConfig;
    /** The commit a Git application's release was read at, and is built from. */
    readonly commitSha: string | null;
  };
  /** Replicas of this release, once placed. */
  readonly allocations: readonly Allocation[];
  /**
   * Replicas of the release currently serving; drained once the switch succeeded. For a stop
   * (`deployment.plan.stop`) or a maintenance change (`deployment.plan.maintenance`), every placed
   * replica of the application, and `allocations` is empty.
   */
  readonly previous: readonly Allocation[];
  /**
   * The hostnames the route matched before this deployment: the domains of the newest release in
   * `previous`, or of this release for a maintenance change. Restoring the previous route needs
   * them, since a deployment can change `domains` (issue #485). Empty when nothing was routed.
   */
  readonly previousHosts: readonly string[];
  /** Outcomes of this deployment's agent actions, by idempotency key. */
  readonly steps: ReadonlyMap<string, StepOutcome>;
}

/** An agent action the pipeline needs, keyed for idempotent enqueueing (one per node and key). */
export type PipelineStep = { readonly key: string; readonly nodeId: string } & (
  | { readonly kind: 'ensure_network'; readonly network: string }
  | { readonly kind: 'pull_image'; readonly image: string }
  | {
      readonly kind: 'build_image';
      /** What builds the image (ADR 0030). */
      readonly builder: 'dockerfile' | 'railpack' | 'nixpacks';
      /** The tag the build pushes; its repository is the application's in the registry. */
      readonly target: string;
      readonly commit: string;
      readonly context: string;
      /** The Dockerfile's path, for a Dockerfile build; empty for Railpack and Nixpacks. */
      readonly dockerfile: string;
      readonly args: Readonly<Record<string, string>>;
    }
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
      /** Serve the agent's maintenance page instead of upstreams, which are then empty. */
      readonly maintenance?: boolean;
    }
  | { readonly kind: 'remove_route'; readonly routeId: string; readonly drainMs: number }
  | { readonly kind: 'stop_container'; readonly container: string; readonly timeoutMs: number }
  | { readonly kind: 'remove_container'; readonly container: string }
);

export type PipelineDecision =
  | { readonly kind: 'done' }
  /** Resolve the release image to a digest and record it (M3.4c2). */
  | { readonly kind: 'resolve_image' }
  /** Record the digest the release's build pushed (ADR 0030). */
  | { readonly kind: 'record_build'; readonly digest: string }
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
      // A stop or a maintenance change starts nothing, so it needs no image: it must work when
      // the registry is down. A build makes its image.
      return deployment.plan.stop ||
        deployment.plan.maintenance ||
        deployment.plan.build ||
        release.pinnedImage
        ? { kind: 'advance' }
        : { kind: 'resolve_image' };
    case 'building':
      return decide(context, build(context));
    case 'built':
      return { kind: 'advance' };
    case 'releasing':
      return decide(context, releaseTask(context));
    case 'scheduling':
      return context.allocations.length ? { kind: 'advance' } : place(context);
    case 'starting':
      return decide(context, all(context.allocations.map((a) => replica(context, a))));
    case 'health_checking':
      return decide(context, all(context.allocations.map((a) => health(context, a))));
    case 'switching':
      return decide(
        context,
        deployment.plan.maintenance ? maintenanceRoutes(context) : switchRoutes(context),
      );
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
  if (routing === 'restore_previous') {
    // The route as it was: the previous release's hostnames, not this release's (issue #485).
    const hosts = context.previousHosts;
    const previous = byNode(context.previous);
    const added = byNode(context.allocations);
    // Leaving maintenance was interrupted: the page goes back on every node, as it was.
    const page = context.deployment.plan.maintenance === 'leave';
    if (hosts.length)
      for (const [nodeId, replicas] of previous)
        steps.push({
          kind: 'upsert_route',
          key: key(context, `restore:${nodeId}`),
          nodeId,
          routeId: context.application.id,
          hosts: [...hosts],
          upstreams: page
            ? []
            : replicas.map((replica) => ({ container: replica.container, port: replica.port })),
          drainMs: 0,
          ...(page ? { maintenance: true } : {}),
        });
    // A node the switch may have routed loses that route when it had none before: it hosts only
    // new replicas, or nothing was routed before this deployment.
    for (const nodeId of added.keys())
      if (!hosts.length || !previous.has(nodeId))
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

/**
 * A Git application's build (ADR 0030): on the server of its first replica, placed first, at the
 * release's commit, pushing the release's tag. Its digest becomes the release's.
 */
function build(context: PipelineContext): Progress | PipelineDecision {
  if (context.release.pinnedImage) return { status: 'done' };
  const first = context.allocations.at(0);
  if (!first) return place(context);
  const commit = context.release.commitSha;
  if (!commit) return { status: 'failed', reason: 'The release names no commit to build.' };
  const config = context.release.config.build;
  const builder =
    config?.type === 'railpack' || config?.type === 'nixpacks' ? config.type : 'dockerfile';
  const step: PipelineStep = {
    kind: 'build_image',
    key: key(context, 'build'),
    nodeId: first.nodeId,
    builder,
    target: context.release.image,
    commit,
    context: repositoryPath(config?.context),
    // Railpack and Nixpacks write their own build: they take no Dockerfile.
    dockerfile: builder === 'dockerfile' ? repositoryPath(config?.dockerfile) || 'Dockerfile' : '',
    args: Object.fromEntries(
      Object.entries(config?.args ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  };
  const progress = chain(context, [step]);
  if (progress.status !== 'done') return progress;
  const digest = context.steps.get(step.key)?.imageDigest;
  if (!digest) return { status: 'failed', reason: 'The build answered no image digest.' };
  return { kind: 'record_build', digest };
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

/**
 * Entering maintenance puts the agent's page on the route of every node that hosts a replica,
 * once the requests they serve have drained; leaving it puts the replicas back (ADR 0025). The
 * replicas keep running either way. Keys match `switchRoutes`, so a cancellation restores the
 * routes the same way.
 */
function maintenanceRoutes(context: PipelineContext): Progress {
  const hosts = domains(context.release.config);
  if (!hosts.length) return { status: 'done' };
  const entering = context.deployment.plan.maintenance === 'enter';
  return all(
    [...byNode(context.previous)].map(([nodeId, replicas]) =>
      chain(context, [
        {
          kind: 'upsert_route',
          key: key(context, `route:${nodeId}`),
          nodeId,
          routeId: context.application.id,
          hosts,
          upstreams: entering
            ? []
            : replicas.map((replica) => ({ container: replica.container, port: replica.port })),
          // The page answers at once: leaving has nothing to drain.
          drainMs: entering ? drainMs(context) : 0,
          ...(entering ? { maintenance: true } : {}),
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
    const pull = step === 'pull' && outcome.reason ? PULL_FAILURES[outcome.reason] : undefined;
    if (pull) return pull;
    const built = step === 'build' && outcome.reason ? BUILD_FAILURES[outcome.reason] : undefined;
    if (built) return built;
    if (outcome.reason === 'image_volume_undeclared') return IMAGE_VOLUME_UNDECLARED;
    if (outcome.reason === 'container_name_taken') return CONTAINER_NAME_TAKEN;
    const text = outcome.reason ? reasonText(outcome.reason) : null;
    return `Step ${step} ${outcome.state}${text ? `: ${text}` : '.'}`;
  }
  return undefined;
}

/** A read-only root refused because the image declares a volume nothing mounts (ADR 0022). */
const IMAGE_VOLUME_UNDECLARED =
  'The server did not create the container: the image declares a volume that the configuration does not mount, and with run.read_only_root Docker would give it an unbounded anonymous volume. Declare that path under volumes, or turn off run.read_only_root.';

/**
 * A create refused because another container holds the name. After a restore from a backup older
 * than the last deployment, a release number is reused (issue #501).
 */
const CONTAINER_NAME_TAKEN =
  'The server did not create the container: another container already has its name. After a restore from an older backup, it is likely the container of a deployment that the backup does not know, and each such deployment makes one more attempt fail: deploy again until one succeeds. That container then shows as untracked on the page of its server, where it can be removed once you have checked that it is no longer needed.';

/** What a failed pull says, by cause: what happened, in words that tell what to check. */
const PULL_FAILURES: Partial<Record<ActionReason, string>> = {
  registry_denied:
    'The server could not pull the image: the registry refused it. The image is private, the stored credentials are wrong, or it does not exist.',
  image_not_found: 'The server could not pull the image: the registry does not have it.',
  registry_unreachable: 'The server could not pull the image: it could not reach the registry.',
  registry_untrusted:
    "The server could not pull the image: it does not trust the registry's certificate.",
  disk_full: 'The server could not pull the image: its disk is full.',
  egress_unguarded:
    "The server refused to pull the image: its Docker daemon does not go through Shipkeep's egress proxy, which keeps a registry from reaching the server's own network. Run the server installer again with --migrate yes to restore it.",
};

/** What a failed build says, by cause (ADR 0030). */
const BUILD_FAILURES: Partial<Record<ActionReason, string>> = {
  build_failed:
    "The build failed: its output, on this deployment's page, says why. Fix the Dockerfile or the repository, then deploy again.",
  build_timeout:
    'The build did not finish within its time limit. Make it faster, for example with a smaller context or cached layers, then deploy again.',
  builder_unavailable:
    "The server's builder does not answer. Run the server installer with --migrate yes to add it, or inspect journalctl -u shipkeep-build on that server.",
};

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
