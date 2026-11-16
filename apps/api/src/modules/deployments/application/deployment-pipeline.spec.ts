import type { ShipkeepConfig } from '@shipkeep/config-schema';
import { type DomainEvent, InvalidInputError, Secret } from '@shipkeep/domain';

import type { DomainEventBus } from '../../../platform/events/domain-event-bus';
import type { SecretStore } from '../../secrets/application/ports';
import type { StepOutcome } from '../domain/pipeline';
import { nodeLoads, type NodeView } from '../domain/placement';
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

type ActionOrigin = Parameters<ActionQueue['enqueue']>[0]['origin'];

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const APP = '0190f5a8-7b1c-7e2d-8f3a-0123456789ab';
const NODE = '0190f5a8-7b1c-7e2d-8f3a-00000000000a';
const DIGEST = `sha256:${'c'.repeat(64)}`;
const NOW = new Date('2026-11-05T12:00:00Z');
/** One CPU and 512 MiB: what an application without `resources` runs under (#301). */
const DEFAULT_LIMITS = { cpuMillis: 1000, memoryBytes: 536_870_912 };

const READY_FACTS = { architecture: 'amd64', cpu_count: 2, memory_bytes: 2 ** 32 };

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
    /** The configuration of the release, when the default one does not fit the case. */
    config?: ShipkeepConfig;
    /** Replicas of the release that serves when the deployment starts. */
    serving?: StoredAllocation[];
    /** Replicas of other applications, counted in the load of their node. */
    neighbours?: Pick<StoredAllocation, 'nodeId' | 'cpuMillis' | 'memoryBytes'>[];
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
    config: options.config ?? config,
    configSha: 'a'.repeat(64),
    createdBy: null,
    createdAt: NOW,
  };
  let allocations: (StoredAllocation & { stopped: boolean })[] = (options.serving ?? []).map(
    (allocation) => ({ ...allocation, stopped: false }),
  );
  const queued = new Map<
    string,
    { nodeId: string; kind: string | undefined; origin: ActionOrigin }
  >();
  const outcomes = new Map<string, StepOutcome>();
  const events: DomainEvent[] = [];
  const nodes = options.nodes ?? [
    {
      id: NODE,
      name: 'edge-1',
      status: 'ready',
      lastHeartbeatAt: NOW,
      labels: {},
      facts: READY_FACTS,
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
      allocations = [
        ...allocations,
        ...replicas.map((r, i) => ({ ...r, id: `alloc-${String(i)}`, releaseId, stopped: false })),
      ];
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
    // Like the store: every placed replica of the organization, from one read.
    load: (_org, replacing) =>
      Promise.resolve(
        nodeLoads(
          [
            ...allocations.filter((a) => !a.stopped).map((a) => ({ ...a, applicationId: APP })),
            ...(options.neighbours ?? []).map((a) => ({
              ...a,
              applicationId: 'other',
              releaseId: 'other-release',
            })),
          ],
          replacing,
        ),
      ),
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
      queued.set(input.idempotencyKey, {
        nodeId: input.nodeId,
        kind: input.action.case,
        origin: input.origin,
      });
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
    pipelineStore: pipeline,
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
    // Every action names its deployment, for the application's action history (#263).
    expect(
      [...w.queued.values()].every(
        (a) => a.origin.applicationId === APP && a.origin.deploymentId === w.deployment.id,
      ),
    ).toBe(true);
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

  it('gives an application without resources the default limits, reserved and enforced', async () => {
    const w = world();
    await w.subject.run(ORG, w.deployment.id, () => NOW);
    // The allocation reserves what the container will be limited to (#301).
    expect(w.allocations).toMatchObject([{ nodeId: NODE, ...DEFAULT_LIMITS }]);
  });

  describe('on a node the serving release fills', () => {
    const oneCore: NodeView = {
      id: NODE,
      name: 'edge-1',
      status: 'ready',
      lastHeartbeatAt: NOW,
      labels: {},
      facts: { architecture: 'amd64', cpu_count: 1, memory_bytes: 2 ** 30 },
    };
    const serving: StoredAllocation = {
      id: 'alloc-serving',
      releaseId: '0190f5a8-7b1c-7e2d-8f3a-00000000000e',
      index: 0,
      nodeId: NODE,
      container: 'sk-billing-api-0123456789ab-r0-0',
      port: 3000,
      ...DEFAULT_LIMITS,
    };

    it('deploys the next release in the room of the one it replaces', async () => {
      const w = world({ nodes: [oneCore], serving: [serving] });
      for (
        let round = 0;
        round < 10 && (await w.subject.run(ORG, w.deployment.id, () => NOW)) === 'wait';
        round++
      )
        w.agentsFinish();
      expect(w.deployment).toMatchObject({ state: 'succeeded', error: null });
      // Only the new release keeps a reservation: the node is exactly full again.
      expect(w.allocations.filter((a) => !a.stopped)).toMatchObject([
        { releaseId: w.deployment.releaseId, ...DEFAULT_LIMITS },
      ]);
    });

    it('still refuses a release when another application holds the room', async () => {
      const w = world({ nodes: [oneCore], neighbours: [{ nodeId: NODE, ...DEFAULT_LIMITS }] });
      await w.subject.run(ORG, w.deployment.id, () => NOW);
      expect(w.deployment).toMatchObject({
        state: 'failed',
        error: 'No node can run replica 1 of 1 (edge-1: cpu).',
      });
      expect(w.allocations).toEqual([]);
    });
  });

  describe('a release that cannot be planned (#314)', () => {
    it('fails the deployment when a value cannot be read, instead of throwing', async () => {
      // Sixteen digits pass the schema and overflow the planner.
      const w = world({ config: { ...config, resources: { cpu: '9999999999999999' } } });
      expect(await w.subject.run(ORG, w.deployment.id, () => NOW)).toBe('done');
      expect(w.deployment).toMatchObject({ state: 'failed', error: 'The cpu value is invalid.' });
      expect(w.events.at(-1)).toMatchObject({
        type: 'deployment.failed',
        payload: { routing: 'untouched' },
      });
      expect(w.allocations).toEqual([]);
      // Nothing is left to retry: the next run finds a finished deployment.
      expect(await w.subject.run(ORG, w.deployment.id, () => NOW)).toBe('done');
    });

    it('fails and cleans up when the value is only read after the replicas started', async () => {
      const w = world({
        config: {
          ...config,
          run: {
            port: 3000,
            healthcheck: { path: '/health', interval: `${'9'.repeat(29)}h` },
          },
        },
      });
      let outcome = 'wait';
      for (let round = 0; round < 10 && outcome === 'wait'; round++) {
        outcome = await w.subject.run(ORG, w.deployment.id, () => NOW);
        w.agentsFinish();
      }
      expect(outcome).toBe('done');
      expect(w.deployment).toMatchObject({
        state: 'failed',
        error: 'The duration value is invalid.',
      });
      // The replica that was created never served: it is removed and its reservation freed.
      expect([...w.queued.values()].map((a) => a.kind)).toContain('removeContainer');
      expect(w.allocations.every((a) => a.stopped)).toBe(true);
    });

    it('still throws what is not about the release, so that the run is retried', async () => {
      const w = world();
      const broken = new Error('connection lost');
      (w.pipelineStore as { nodes: unknown }).nodes = () => Promise.reject(broken);
      await expect(w.subject.run(ORG, w.deployment.id, () => NOW)).rejects.toBe(broken);
      expect(w.deployment.state).not.toBe('failed');
    });
  });

  describe('a node without capacity facts (#314)', () => {
    const silent: NodeView = {
      id: '0190f5a8-7b1c-7e2d-8f3a-00000000000b',
      name: 'edge-0',
      status: 'ready',
      lastHeartbeatAt: NOW,
      labels: {},
      facts: {},
    };
    const ready: NodeView = { ...silent, id: NODE, name: 'edge-1', facts: READY_FACTS };

    it('does not stop a deployment that fits on another node', async () => {
      const w = world({ nodes: [silent, ready] });
      await w.subject.run(ORG, w.deployment.id, () => NOW);
      expect(w.deployment.state).toBe('starting');
      expect(w.allocations).toMatchObject([{ nodeId: NODE }]);
    });

    it('is named in the reason when it is the only node', async () => {
      const w = world({ nodes: [silent] });
      expect(await w.subject.run(ORG, w.deployment.id, () => NOW)).toBe('done');
      expect(w.deployment).toMatchObject({
        state: 'failed',
        error: 'No node can run replica 1 of 1 (edge-0: architecture).',
      });
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
