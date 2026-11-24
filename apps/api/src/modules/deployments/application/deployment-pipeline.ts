import { Inject, Injectable } from '@nestjs/common';
import {
  advance,
  createEvent,
  type DomainEvent,
  isDomainError,
  type PlacementRejection,
  type PlacementRequest,
  placeReplicas,
  rollBack,
  type RoutingOutcome,
  type SchedulableNode,
  stop,
  SYSTEM_ACTOR,
} from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { APPLICATION_STORE, type ApplicationStore } from '../../apps/application/ports';
import { domainsReleased } from '../../apps/domain/domain-events';
import {
  REGISTRY_CREDENTIAL_STORE,
  type RegistryCredentialStore,
} from '../../registries/application/ports';
import { DOCKER_HUB_SERVER, type RegistryLogin } from '../../registries/domain/registry-credential';
import { SECRET_STORE, type SecretStore } from '../../secrets/application/ports';
import { containerName } from '../domain/container-plan';
import {
  acceptsDockerHubCredentials,
  credentialServer,
  parseImageReference,
  pinnedReference,
} from '../domain/image-reference';
import {
  type PipelineContext,
  type PipelineDecision,
  type PipelineStep,
  plan,
  recovery,
} from '../domain/pipeline';
import { placementRequest, schedulableNodes } from '../domain/placement';
import type { DeploymentRecord } from '../domain/release';
import { agentAction, type RegistryAccess, type SecretValues } from '../infrastructure/agent-steps';

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
    @Inject(REGISTRY_CREDENTIAL_STORE) private readonly registries: RegistryCredentialStore,
    @Inject(DEPLOYMENT_TRANSACTION) private readonly transaction: DeploymentTransaction,
    private readonly events: DomainEventBus,
    @Inject(APPLICATION_STORE) private readonly applications: ApplicationStore,
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
      let decision: PipelineDecision;
      try {
        decision = plan(loaded.context);
      } catch (error: unknown) {
        // A release the planner cannot read fails like any other failure. Throwing would only
        // retry the run and leave the deployment where it is, holding the application.
        if (!isDomainError(error)) throw error;
        return this.fail(loaded, error.message, clock());
      }
      const outcome = await this.apply(loaded, decision, clock);
      if (outcome !== 'continue') return outcome;
    }
    return 'wait';
  }

  private async apply(
    loaded: Loaded,
    decision: PipelineDecision,
    clock: () => Date,
  ): Promise<'continue' | 'wait' | 'done'> {
    const { context, application } = loaded;
    const now = clock();
    switch (decision.kind) {
      case 'done':
        // A deployment cancelled through the API still holds its replicas: clean them up once. A
        // maintenance change holds none, but may have switched routes: put back what they served
        // (ADR 0025). Running it again only finds the same keyed steps already queued.
        if (
          context.deployment.state === 'cancelled' &&
          (context.allocations.length || context.deployment.plan.maintenance)
        )
          await this.tenant(application, () =>
            this.recover(loaded, cancelledRouting(context), now),
          );
        // A finished deployment runs again when one of its actions ends, such as the route removal
        // of its cleanup: what that action held reserved may now be free (#302).
        await this.tenant(application, () => this.releaseDomains(application, now));
        return 'done';
      case 'resolve_image': {
        const image = context.release.config.build?.image ?? '';
        let login: RegistryLogin | undefined;
        try {
          // Read in its own transaction, which ends before the registry is called.
          login = await this.registryLogin(application, image);
        } catch (error: unknown) {
          // Stored credentials that cannot be read fail the deployment; a database error retries.
          if (!isDomainError(error)) throw error;
          return this.fail(loaded, error.message, now);
        }
        // Outside any transaction: a registry call must never hold database locks.
        let pinned: string;
        try {
          pinned = await this.resolver.resolve(image, login);
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
        // Placement may wait for a lock: it reads the time itself, once it holds it.
        return this.place(loaded, decision.replicas, clock);
      case 'run':
        if (decision.steps.length) {
          const outcome = await this.tenant(application, async () => {
            // The deployment's row lock orders these actions with a cancellation, which updates
            // that row before it frees domains: either the cancellation sees the route actions
            // queued here and keeps their domains reserved, or this run sees it and queues
            // nothing (#302).
            if (
              (await this.deployments.lockState(context.deployment.id)) !== context.deployment.state
            )
              return { stale: true } as const;
            return { failure: await this.enqueue(loaded, decision.steps, now) };
          });
          if ('stale' in outcome) return 'continue';
          if (outcome.failure) return this.fail(loaded, outcome.failure, now);
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
    // A stop places nothing: every placed replica is one it removes, whatever its release. A
    // maintenance change places nothing either, and only changes the routes of every placed
    // replica: none of them is stopped when it succeeds (ADR 0025).
    const stopping = deployment.plan.stop === true;
    const maintenance = deployment.plan.maintenance !== undefined;
    const previous =
      stopping || maintenance ? allocations : allocations.filter((a) => a.releaseId !== release.id);
    return {
      application,
      previousReleases: maintenance ? [] : [...new Set(previous.map((a) => a.releaseId))],
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
        allocations:
          stopping || maintenance ? [] : allocations.filter((a) => a.releaseId === release.id),
        previous,
        steps,
      },
    };
  }

  private place(loaded: Loaded, replicas: number, clock: () => Date): Promise<'continue' | 'done'> {
    const { context, application } = loaded;
    const config = context.release.config;
    return this.tenant(application, async () => {
      // One placement at a time per organization: the next one reads the load only after this
      // transaction has stored its replicas, or has given up (SPEC 6).
      await this.pipeline.lockPlacement(application.organizationId);
      const nodes = await this.pipeline.nodes(application.organizationId);
      // The replicas this deployment replaces give their room to the new release (SPEC 6).
      const load = await this.pipeline.load(application.organizationId, {
        applicationId: application.id,
        releaseId: context.release.id,
      });
      // The time is read here, not before the lock: a node whose heartbeats stopped while this
      // placement waited is no longer ready (SPEC 5.2).
      const now = clock();
      const scheduler = schedulableNodes(nodes, load, now);
      let request: PlacementRequest;
      let placed: ReturnType<typeof schedule>;
      try {
        request = placementRequest(application.id, config);
        placed = schedule(request, replicas, scheduler);
      } catch (error: unknown) {
        // Same rule as for the planner: a release that cannot be scheduled fails, it is not retried.
        if (!isDomainError(error)) throw error;
        return this.failInTransaction(loaded, error.message, now);
      }
      if ('failure' in placed) return this.failInTransaction(loaded, placed.failure, now);
      const ids = new Map(nodes.map((node) => [node.name, node.id]));
      const allocations = placed.nodes.map((name, index) => ({
        index,
        nodeId: ids.get(name) ?? '',
        container: containerName(application, context.release.number, index),
        port: config.run?.port ?? 0,
        // What placement reserved, which is also what the container plan enforces.
        ...request.resources,
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
    const deadline = new Date(now.getTime() + ACTION_LIFETIME_MS);
    let registries: RegistryAccess;
    try {
      const logins = await this.registryLogins(loaded, steps);
      // Credentials sent to an agent are valid for as long as the action that carries them.
      registries = {
        logins,
        expiresAt: deadline,
        withoutDockerHub: logins.has(DOCKER_HUB_SERVER)
          ? await this.agentsBeforeDockerHubRule(loaded.application.organizationId)
          : new Set(),
      };
    } catch (error: unknown) {
      if (!isDomainError(error)) throw error;
      return error.message;
    }
    for (const step of steps) {
      let action: ReturnType<typeof agentAction>;
      try {
        action = agentAction(step, values, registries);
      } catch (error: unknown) {
        return reason(error, 'A step could not be prepared.');
      }
      await this.actions.enqueue({
        organizationId: loaded.application.organizationId,
        nodeId: step.nodeId,
        idempotencyKey: step.key,
        action,
        deadline,
        actor: SYSTEM_ACTOR,
        origin: {
          applicationId: loaded.application.id,
          deploymentId: loaded.context.deployment.id,
        },
      });
    }
    return undefined;
  }

  /** What the organization stored for the registries of the images these steps pull (ADR 0019). */
  private async registryLogins(
    loaded: Loaded,
    steps: readonly PipelineStep[],
  ): Promise<Map<string, RegistryLogin>> {
    const servers = new Set<string>();
    for (const step of steps)
      if (step.kind === 'pull_image')
        servers.add(credentialServer(parseImageReference(step.image)));
    const logins = new Map<string, RegistryLogin>();
    for (const server of servers) {
      const login = await this.registries.login(loaded.application.organizationId, server);
      if (login) logins.set(server, login);
    }
    return logins;
  }

  /** Nodes whose agent would refuse a pull that carries Docker Hub credentials (ADR 0019). */
  private async agentsBeforeDockerHubRule(organizationId: string): Promise<Set<string>> {
    const nodes = await this.pipeline.nodes(organizationId);
    return new Set(
      nodes
        .filter((node) => !acceptsDockerHubCredentials(node.facts['agent_version']))
        .map((node) => node.id),
    );
  }

  /**
   * The stored credentials of the registry an image reference names, if any. A reference that
   * cannot be read gets none: the resolver reports it.
   */
  private async registryLogin(
    application: PipelineApplication,
    image: string,
  ): Promise<RegistryLogin | undefined> {
    let server: string;
    try {
      server = credentialServer(parseImageReference(image));
    } catch {
      return undefined;
    }
    return this.tenant(application, () =>
      this.registries.login(application.organizationId, server),
    );
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
        // Domains the configuration dropped are free once no placed release serves them (#302).
        await this.releaseDomains(application, now);
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
    if (routing !== 'new_release_serving') {
      // A maintenance change runs the release that serves: its replicas keep running.
      if (!loaded.context.deployment.plan.maintenance)
        await this.pipeline.stop(loaded.application.id, [loaded.context.release.id], now);
      await this.releaseDomains(loaded.application, now);
    }
  }

  /** Frees what nothing serves any more and audits each domain freed (#302). */
  private async releaseDomains(application: PipelineApplication, now: Date): Promise<void> {
    const released = await this.applications.releaseUnservedDomains(application);
    if (released.length)
      await this.events.publish(domainsReleased(application, released, SYSTEM_ACTOR, now));
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

/** The node of each replica, or why one of them fits nowhere. Pure: it only throws domain errors. */
function schedule(
  request: PlacementRequest,
  replicas: number,
  nodes: readonly SchedulableNode[],
): { readonly nodes: readonly string[] } | { readonly failure: string } {
  const placed = placeReplicas(request, replicas, nodes);
  if (placed.unplaced === 0) return { nodes: placed.nodes };
  // Why the failing replica was refused, beside the replicas placed before it. Without a node to
  // refuse it, the organization has no server that runs applications: none, or only control
  // plane machines (ADR 0028).
  const reasons =
    Object.entries(placed.rejections ?? {})
      .map(([node, why]) => `${node}: ${REJECTIONS[why] ?? why}`)
      .join(', ') || NO_SERVER;
  return {
    failure: `No node can run replica ${String(replicas - placed.unplaced + 1)} of ${String(replicas)} (${reasons}).`,
  };
}

/** The reason when no node can take an application at all. */
export const NO_SERVER = 'no server runs applications; add one on the Servers page';

/**
 * Rejections that need more words than their name. On the machine that hosts the control plane, a
 * redeployment that does not fit beside the release it replaces is refused before it starts
 * (ADR 0021): lowering its limits or placing it on another server makes room.
 */
const REJECTIONS: Partial<Record<PlacementRejection, string>> = {
  surge:
    'the old and the new release do not fit together beside the control plane reservation; lower the limits or place the application on another server',
};

function reason(error: unknown, fallback: string): string {
  return isDomainError(error) ? error.message : fallback;
}
