import type { ShipkeepConfig } from '@shipkeep/config-schema';
import { type DomainEvent, InvalidInputError, Secret } from '@shipkeep/domain';

import type { DomainEventBus } from '../../../platform/events/domain-event-bus';
import type { SecretStore } from '../../secrets/application/ports';
import type { StepOutcome } from '../domain/pipeline';
import type { NodeView } from '../domain/placement';
import type { DeploymentRecord, Release } from '../domain/release';

import { DeploymentPipeline } from './deployment-pipeline';
import type {
  ActionQueue,
  DeploymentStore,
  DeploymentTransaction,
  ImageResolver,
  PipelineStore,
  StoredAllocation,
} from './ports';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const APP = '0190f5a8-7b1c-7e2d-8f3a-0123456789ab';
const NODE = '0190f5a8-7b1c-7e2d-8f3a-00000000000a';
const DIGEST = `sha256:${'c'.repeat(64)}`;
const NOW = new Date('2026-11-05T12:00:00Z');

const config: ShipkeepConfig = {
  version: 1,
  name: 'billing-api',
  build: { type: 'image', image: 'ghcr.io/acme/billing:1.4.2' },
  run: { port: 3000, healthcheck: { path: '/health' } },
  domains: ['api.acme.example.com'],
  secrets: ['DATABASE_URL'],
};

function world(
  options: {
    nodes?: NodeView[];
    secrets?: string[];
    resolve?: () => Promise<string>;
    trigger?: DeploymentRecord['trigger'];
  } = {},
) {
  let deployment: DeploymentRecord = {
    id: '0190f5a8-7b1c-7e2d-8f3a-00000000000d',
    organizationId: ORG,
    applicationId: APP,
    releaseId: '0190f5a8-7b1c-7e2d-8f3a-00000000000f',
    state: 'queued',
    plan: { build: false, release: false },
    trigger: options.trigger ?? 'manual',
    actorId: null,
    startedAt: NOW,
    finishedAt: null,
    error: null,
  };
  let release: Release = {
    id: deployment.releaseId,
    organizationId: ORG,
    applicationId: APP,
    number: 1,
    image: 'ghcr.io/acme/billing:1.4.2',
    imageDigest: null,
    config,
    configSha: 'a'.repeat(64),
    createdBy: null,
    createdAt: NOW,
  };
  let allocations: (StoredAllocation & { stopped: boolean })[] = [];
  const queued = new Map<string, { nodeId: string; kind: string | undefined }>();
  const outcomes = new Map<string, StepOutcome>();
  const events: DomainEvent[] = [];
  const nodes = options.nodes ?? [
    {
      id: NODE,
      name: 'edge-1',
      status: 'ready',
      lastHeartbeatAt: NOW,
      labels: {},
      facts: { architecture: 'amd64', cpu_count: 2, memory_bytes: 2 ** 32 },
    },
  ];

  const replaced: DeploymentRecord = { ...deployment, id: 'd-old', state: 'succeeded' };
  const superseded: { id: string; state: string }[] = [];
  const deployments = {
    byId: () => Promise.resolve(deployment),
    succeededOf: () => Promise.resolve([replaced]),
    transition: (next: DeploymentRecord, expected: string) => {
      if (next.id === replaced.id) {
        superseded.push({ id: next.id, state: next.state });
        return Promise.resolve(true);
      }
      if (deployment.state !== expected) return Promise.resolve(false);
      deployment = next;
      return Promise.resolve(true);
    },
  } as unknown as DeploymentStore;
  const pipeline: PipelineStore = {
    application: () =>
      Promise.resolve({
        id: APP,
        organizationId: ORG,
        projectId: ORG,
        environmentId: ORG,
        name: 'billing-api',
      }),
    release: () => Promise.resolve(release),
    allocations: () => Promise.resolve(allocations.filter((a) => !a.stopped)),
    steps: () => Promise.resolve(new Map(outcomes)),
    place: (_org, _app, releaseId, replicas) => {
      if (allocations.some((a) => a.releaseId === releaseId)) return Promise.resolve(false);
      allocations = replicas.map((r, i) => ({
        ...r,
        id: `alloc-${String(i)}`,
        releaseId,
        stopped: false,
      }));
      return Promise.resolve(true);
    },
    stop: (_app, releaseIds) => {
      allocations = allocations.map((a) =>
        releaseIds.includes(a.releaseId) ? { ...a, stopped: true } : a,
      );
      return Promise.resolve();
    },
    recordDigest: (_id, digest) => {
      if (release.imageDigest) return Promise.resolve(false);
      release = { ...release, imageDigest: digest };
      return Promise.resolve(true);
    },
    nodes: () => Promise.resolve(nodes),
    load: () => Promise.resolve(new Map()),
  };
  const secretStore = {
    values: (_target: unknown, names: readonly string[]) =>
      Promise.resolve(
        names
          .filter((name) => (options.secrets ?? ['DATABASE_URL']).includes(name))
          .map((name) => ({ name, version: 1, value: new Secret('fixture') })),
      ),
  } as unknown as SecretStore;
  const resolver: ImageResolver = {
    resolve: options.resolve ?? (() => Promise.resolve(`ghcr.io/acme/billing@${DIGEST}`)),
  };
  const actions: ActionQueue = {
    enqueue: (input) => {
      queued.set(input.idempotencyKey, { nodeId: input.nodeId, kind: input.action.case });
      return Promise.resolve({ id: input.idempotencyKey, created: true });
    },
  };
  const transaction: DeploymentTransaction = { runTenant: (_org, work) => work() };
  const bus = {
    publish: (batch: DomainEvent[]) => {
      events.push(...batch);
      return Promise.resolve();
    },
  } as unknown as DomainEventBus;
  const subject = new DeploymentPipeline(
    deployments,
    pipeline,
    secretStore,
    resolver,
    actions,
    transaction,
    bus,
  );

  /** Agents finish every queued action successfully. */
  const agentsFinish = () => {
    for (const [key, action] of queued)
      if (!outcomes.has(key))
        outcomes.set(key, {
          state: 'succeeded',
          ...(action.kind === 'createContainer' ? { containerId: 'f'.repeat(64) } : {}),
          ...(action.kind === 'healthCheck' ? { healthy: true } : {}),
        });
  };
  return {
    subject,
    events,
    superseded,
    queued,
    outcomes,
    agentsFinish,
    get deployment() {
      return deployment;
    },
    get release() {
      return release;
    },
    get allocations() {
      return allocations;
    },
    cancel() {
      deployment = {
        ...deployment,
        state: 'cancelled',
        finishedAt: NOW,
        error: 'Cancelled by a user.',
      };
    },
  };
}

describe('DeploymentPipeline', () => {
  it('drives a deployment to success through agent actions, auditing each transition', async () => {
    const w = world();
    for (
      let round = 0;
      round < 10 && (await w.subject.run(ORG, w.deployment.id, () => NOW)) === 'wait';
      round++
    )
      w.agentsFinish();
    expect(w.deployment.state).toBe('succeeded');
    expect(w.release.imageDigest).toBe(DIGEST);
    expect([...w.queued.values()].map((a) => a.kind)).toEqual([
      'ensureNetwork',
      'pullImage',
      'createContainer',
      'startContainer',
      'healthCheck',
      'upsertRoute',
    ]);
    expect(w.events.map((e) => [e.type, e.payload['to'] ?? ''])).toEqual([
      ['release.image_resolved', ''],
      ['deployment.advanced', 'scheduling'],
      ['deployment.placed', ''],
      ['deployment.advanced', 'starting'],
      ['deployment.advanced', 'health_checking'],
      ['deployment.advanced', 'switching'],
      ['deployment.advanced', 'draining'],
      ['deployment.advanced', 'succeeded'],
    ]);
    expect(
      w.events.every((e) => e.actor.kind === 'system' && !JSON.stringify(e).includes('fixture')),
    ).toBe(true);
    expect(await w.subject.run(ORG, w.deployment.id, () => NOW)).toBe('done');
  });

  it('supersedes the replaced deployment when a rollback succeeds', async () => {
    const w = world({ trigger: 'rollback' });
    for (
      let round = 0;
      round < 10 && (await w.subject.run(ORG, w.deployment.id, () => NOW)) === 'wait';
      round++
    )
      w.agentsFinish();
    expect(w.deployment.state).toBe('succeeded');
    expect(w.superseded).toEqual([{ id: 'd-old', state: 'rolled_back' }]);
    expect(w.events.at(-1)).toMatchObject({
      type: 'deployment.rolled_back',
      target: { id: 'd-old' },
    });
  });

  it('supersedes nothing after an ordinary deployment', async () => {
    const w = world();
    for (
      let round = 0;
      round < 10 && (await w.subject.run(ORG, w.deployment.id, () => NOW)) === 'wait';
      round++
    )
      w.agentsFinish();
    expect(w.superseded).toEqual([]);
  });

  it('fails with an operator explanation when no node can take a replica', async () => {
    const w = world({ nodes: [] });
    expect(await w.subject.run(ORG, w.deployment.id, () => NOW)).toBe('done');
    expect(w.deployment).toMatchObject({
      state: 'failed',
      error: 'No node can run replica 1 of 1 (no nodes).',
    });
    expect(w.events.at(-1)).toMatchObject({
      type: 'deployment.failed',
      payload: { routing: 'untouched' },
    });
  });

  it('fails cleanly when the image cannot be resolved', async () => {
    const w = world({
      resolve: () =>
        Promise.reject(
          new InvalidInputError('image_resolution_failed', 'Could not resolve the tag.'),
        ),
    });
    expect(await w.subject.run(ORG, w.deployment.id, () => NOW)).toBe('done');
    expect(w.deployment).toMatchObject({ state: 'failed', error: 'Could not resolve the tag.' });
    expect(w.queued.size).toBe(0);
  });

  it('fails a deployment whose secret disappeared, and stops what it created', async () => {
    const w = world({ secrets: [] });
    for (
      let round = 0;
      round < 10 && (await w.subject.run(ORG, w.deployment.id, () => NOW)) === 'wait';
      round++
    )
      w.agentsFinish();
    expect(w.deployment).toMatchObject({
      state: 'failed',
      error: 'A secret the release references is not set.',
    });
    expect([...w.queued.values()].some((a) => a.kind === 'createContainer')).toBe(false);
    expect(w.allocations.every((a) => a.stopped)).toBe(true);
  });

  it('cleans up a deployment cancelled through the API once', async () => {
    const w = world();
    for (let round = 0; round < 10; round++) {
      await w.subject.run(ORG, w.deployment.id, () => NOW);
      w.agentsFinish();
      if ([...w.queued.values()].some((a) => a.kind === 'createContainer')) break;
    }
    w.cancel();
    expect(await w.subject.run(ORG, w.deployment.id, () => NOW)).toBe('done');
    expect([...w.queued.keys()].filter((key) => key.includes(':cleanup:'))).toHaveLength(1);
    expect(w.allocations.every((a) => a.stopped)).toBe(true);
    // Nothing is left to clean up the second time.
    await w.subject.run(ORG, w.deployment.id, () => NOW);
    expect([...w.queued.keys()].filter((key) => key.includes(':cleanup:'))).toHaveLength(1);
  });
});
