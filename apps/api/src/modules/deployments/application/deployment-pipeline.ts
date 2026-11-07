import { Inject, Injectable } from '@nestjs/common';
import {
  advance,
  createEvent,
  type DomainEvent,
  isDomainError,
  placeReplica,
  placeReplicas,
  rollBack,
  type RoutingOutcome,
  stop,
  SYSTEM_ACTOR,
} from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { SECRET_STORE, type SecretStore } from '../../secrets/application/ports';
import { containerName, cpuMillis, sizeBytes } from '../domain/container-plan';
import { parseImageReference, pinnedReference } from '../domain/image-reference';
import {
  type PipelineContext,
  type PipelineDecision,
  type PipelineStep,
  plan,
  recovery,
} from '../domain/pipeline';
import { placementRequest, schedulableNodes } from '../domain/placement';
import type { DeploymentRecord } from '../domain/release';
import { agentAction, type SecretValues } from '../infrastructure/agent-steps';

import {
  ACTION_QUEUE,
  type ActionQueue,
  DEPLOYMENT_STORE,
  DEPLOYMENT_TRANSACTION,
  type DeploymentStore,
  type DeploymentTransaction,
  IMAGE_RESOLVER,
  type ImageResolver,
  PIPELINE_STORE,
  type PipelineApplication,
  type PipelineStore,
} from './ports';

/** Agent actions get an hour: release tasks and health probes are bounded well below it. */
const ACTION_LIFETIME_MS = 3600_000;
/** Decisions applied in one run before yielding; each one moves the deployment forward. */
const MAX_DECISIONS = 20;

interface Loaded {
  readonly context: PipelineContext;
  readonly application: PipelineApplication;
  /** Releases whose replicas this deployment replaces. */
  readonly previousReleases: readonly string[];
}

/**
 * Drives one deployment with the planner (SPEC 5.1, PLAN M3.4c4c). Each run loads the observed
 * state, applies decisions until the deployment waits on agents or finishes, and audits every
 * state change. Runs are idempotent: actions are keyed, transitions compare-and-swap the state.
 */
@Injectable()
export class DeploymentPipeline {
  constructor(
    @Inject(DEPLOYMENT_STORE) private readonly deployments: DeploymentStore,
    @Inject(PIPELINE_STORE) private readonly pipeline: PipelineStore,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(IMAGE_RESOLVER) private readonly resolver: ImageResolver,
    @Inject(ACTION_QUEUE) private readonly actions: ActionQueue,
    @Inject(DEPLOYMENT_TRANSACTION) private readonly transaction: DeploymentTransaction,
    private readonly events: DomainEventBus,
  ) {}

  /** `wait` when agents still work for it, `done` when it finished or no longer exists. */
  async run(
    organizationId: string,
    deploymentId: string,
    clock = () => new Date(),
  ): Promise<'wait' | 'done'> {
    for (let round = 0; round < MAX_DECISIONS; round++) {
      const loaded = await this.transaction.runTenant(organizationId, () =>
        this.load(deploymentId),
      );
      if (!loaded) return 'done';
      const decision = plan(loaded.context);
      const outcome = await this.apply(loaded, decision, clock());
      if (outcome !== 'continue') return outcome;
    }
    return 'wait';
  }

  private async apply(
    loaded: Loaded,
    decision: PipelineDecision,
    now: Date,
  ): Promise<'continue' | 'wait' | 'done'> {
    const { context, application } = loaded;
    switch (decision.kind) {
      case 'done':
        // A deployment cancelled through the API still holds its replicas: clean them up once.
        if (context.deployment.state === 'cancelled' && context.allocations.length)
          await this.tenant(application, () =>
            this.recover(loaded, cancelledRouting(context), now),
          );
        return 'done';
      case 'resolve_image': {
        // Outside any transaction: a registry call must never hold database locks.
        let pinned: string;
        try {
          pinned = await this.resolver.resolve(context.release.config.build?.image ?? '');
        } catch (error: unknown) {
          return this.fail(loaded, reason(error, 'The image could not be resolved.'), now);
        }
        const digest = pinned.slice(pinned.lastIndexOf('@') + 1);
        await this.tenant(application, async () => {
          if (await this.pipeline.recordDigest(context.release.id, digest))
            await this.events.publish([
              this.event(
                'release.image_resolved',
                application,
                'release',
                context.release.id,
                now,
                {
                  digest,
                },
              ),
            ]);
        });
        return 'continue';
      }
      case 'place':
        return this.place(loaded, decision.replicas, now);
      case 'run':
        if (decision.steps.length) {
          const failure = await this.tenant(application, () =>
            this.enqueue(loaded, decision.steps, now),
          );
          if (failure) return this.fail(loaded, failure, now);
        }
        return 'wait';
      case 'advance':
        return this.transition(
          loaded,
          { ...context.deployment, ...advance(context.deployment, now) },
          now,
        );
      case 'fail':
        return this.fail(loaded, decision.reason, now);
    }
  }

  private async load(deploymentId: string): Promise<Loaded | undefined> {
    const deployment = await this.deployments.byId(deploymentId);
    if (!deployment) return undefined;
    const [application, release, allocations, steps] = await Promise.all([
      this.pipeline.application(deployment.applicationId),
      this.pipeline.release(deployment.releaseId),
      this.pipeline.allocations(deployment.applicationId),
      this.pipeline.steps(deployment.id),
    ]);
    if (!application || !release) return undefined;
    const previous = allocations.filter((a) => a.releaseId !== release.id);
    return {
      application,
      previousReleases: [...new Set(previous.map((a) => a.releaseId))],
      context: {
        deployment,
        application: {
          id: application.id,
          name: application.name,
          environmentId: application.environmentId,
        },
        release: {
          id: release.id,
          number: release.number,
          pinnedImage: release.imageDigest
            ? pinnedReference(parseImageReference(release.image), release.imageDigest)
            : null,
          config: release.config,
        },
        allocations: allocations.filter((a) => a.releaseId === release.id),
        previous,
        steps,
      },
    };
  }

  private place(loaded: Loaded, replicas: number, now: Date): Promise<'continue' | 'done'> {
    const { context, application } = loaded;
    const config = context.release.config;
    return this.tenant(application, async () => {
      const nodes = await this.pipeline.nodes(application.organizationId);
      const scheduler = schedulableNodes(
        nodes,
        await this.pipeline.load(application.organizationId),
        now,
      );
      const request = placementRequest(application.id, config);
      const placed = placeReplicas(request, replicas, scheduler);
      if (placed.unplaced > 0) {
        const decision = placeReplica(request, scheduler);
        const reasons = decision.placed
          ? 'capacity'
          : Object.entries(decision.rejections)
              .map(([node, why]) => `${node}: ${why}`)
              .join(', ') || 'no nodes';
        return this.failInTransaction(
          loaded,
          `No node can run replica ${String(replicas - placed.unplaced + 1)} of ${String(replicas)} (${reasons}).`,
          now,
        );
      }
      const ids = new Map(nodes.map((node) => [node.name, node.id]));
      const allocations = placed.nodes.map((name, index) => ({
        index,
        nodeId: ids.get(name) ?? '',
        container: containerName(application, context.release.number, index),
        port: config.run?.port ?? 0,
        cpuMillis: cpuMillis(config.resources?.cpu),
        memoryBytes: sizeBytes(config.resources?.memory),
      }));
      if (
        await this.pipeline.place(
          application.organizationId,
          application.id,
          context.release.id,
          allocations,
          now,
        )
      )
        await this.events.publish([
          this.event('deployment.placed', application, 'deployment', context.deployment.id, now, {
            replicas: allocations.length,
            nodes: allocations.map((allocation) => allocation.nodeId).join(','),
          }),
        ]);
      return 'continue';
    });
  }

  /** Enqueues steps; returns a failure reason when one cannot be built (for example a secret). */
  private async enqueue(
    loaded: Loaded,
    steps: readonly PipelineStep[],
    now: Date,
  ): Promise<string | undefined> {
    const values = await this.secretValues(loaded, steps);
    for (const step of steps) {
      let action: ReturnType<typeof agentAction>;
      try {
        action = agentAction(step, values);
      } catch (error: unknown) {
        return reason(error, 'A step could not be prepared.');
      }
      await this.actions.enqueue({
        organizationId: loaded.application.organizationId,
        nodeId: step.nodeId,
        idempotencyKey: step.key,
        action,
        deadline: new Date(now.getTime() + ACTION_LIFETIME_MS),
        actor: SYSTEM_ACTOR,
      });
    }
    return undefined;
  }

  private async secretValues(
    loaded: Loaded,
    steps: readonly PipelineStep[],
  ): Promise<SecretValues> {
    const names = new Set<string>();
    for (const step of steps)
      if (step.kind === 'create_container' || step.kind === 'run_release_task')
        for (const name of step.container.secrets) names.add(name);
    if (!names.size) return new Map();
    const { application } = loaded;
    const values = await this.secrets.values(
      {
        organizationId: application.organizationId,
        projectId: application.projectId,
        environmentId: application.environmentId,
      },
      [...names],
    );
    return new Map(
      values.map((entry) => [entry.name, { version: entry.version, value: entry.value }]),
    );
  }

  private async transition(loaded: Loaded, next: DeploymentRecord, now: Date): Promise<'continue'> {
    const { context, application } = loaded;
    const current = context.deployment;
    await this.tenant(application, async () => {
      if (!(await this.deployments.transition({ ...current, ...next }, current.state, now))) return;
      const events = [
        this.event('deployment.advanced', application, 'deployment', current.id, now, {
          from: current.state,
          to: next.state,
        }),
      ];
      // The new release serves: the replaced replicas are gone once draining succeeded.
      if (next.state === 'succeeded') {
        await this.pipeline.stop(application.id, loaded.previousReleases, now);
        // SPEC 5.1: a succeeded rollback supersedes the deployment it replaced.
        if (current.trigger === 'rollback')
          for (const replaced of await this.deployments.succeededOf(
            application.id,
            loaded.previousReleases,
          ))
            if (
              await this.deployments.transition(
                { ...replaced, ...rollBack(replaced) },
                'succeeded',
                now,
              )
            )
              events.push(
                this.event('deployment.rolled_back', application, 'deployment', replaced.id, now, {
                  rollback: current.id,
                }),
              );
      }
      await this.events.publish(events);
    });
    return 'continue';
  }

  private fail(loaded: Loaded, why: string, now: Date): Promise<'done'> {
    return this.tenant(loaded.application, () => this.failInTransaction(loaded, why, now));
  }

  /** Fails the deployment, then enqueues the best-effort recovery (SPEC 5.1). */
  private async failInTransaction(loaded: Loaded, why: string, now: Date): Promise<'done'> {
    const { context, application } = loaded;
    const current = context.deployment;
    const stopped = stop(current, 'failed', why, now);
    const failed = { ...current, ...stopped.deployment };
    if (!(await this.deployments.transition(failed, current.state, now))) return 'done';
    await this.events.publish([
      this.event('deployment.failed', application, 'deployment', current.id, now, {
        from: current.state,
        reason: failed.error ?? '',
        routing: stopped.routing,
      }),
    ]);
    await this.recover(loaded, stopped.routing, now);
    return 'done';
  }

  private async recover(loaded: Loaded, routing: RoutingOutcome, now: Date): Promise<void> {
    const steps = recovery(loaded.context, routing);
    await this.enqueue(loaded, steps, now);
    if (routing !== 'new_release_serving')
      await this.pipeline.stop(loaded.application.id, [loaded.context.release.id], now);
  }

  private tenant<T>(application: PipelineApplication, work: () => Promise<T>): Promise<T> {
    return this.transaction.runTenant(application.organizationId, work);
  }

  private event(
    type: string,
    application: PipelineApplication,
    targetType: string,
    id: string,
    now: Date,
    payload: Record<string, string | number>,
  ): DomainEvent {
    return createEvent({
      type,
      organizationId: application.organizationId,
      actor: SYSTEM_ACTOR,
      target: { type: targetType, id },
      payload: {
        projectId: application.projectId,
        environmentId: application.environmentId,
        applicationId: application.id,
        ...payload,
      },
      occurredAt: now,
    });
  }
}

/** Where a cancelled deployment left traffic, from the route steps it ran (SPEC 5.1). */
function cancelledRouting(context: PipelineContext): RoutingOutcome {
  const ran = (step: string) =>
    [...context.steps.keys()].some((key) => key.startsWith(`d:${context.deployment.id}:${step}:`));
  if (ran('unroute') || ran('stop')) return 'new_release_serving';
  return ran('route') ? 'restore_previous' : 'untouched';
}

function reason(error: unknown, fallback: string): string {
  return isDomainError(error) ? error.message : fallback;
}
