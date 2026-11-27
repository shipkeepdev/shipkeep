import type { ShipkeepConfig } from '@shipkeep/config-schema';
import { advance, type DeploymentState, stop } from '@shipkeep/domain';

import { containerName } from './container-plan';
import {
  type Allocation,
  type PipelineContext,
  type PipelineStep,
  plan,
  recovery,
  type StepOutcome,
} from './pipeline';
import type { DeploymentRecord } from './release';

const APP = {
  id: '0190f5a8-7b1c-7e2d-8f3a-0123456789ab',
  name: 'billing-api',
  environmentId: '0190f5a8-7b1c-7e2d-8f3a-0123456789ac',
};
const NODES = [
  '0190f5a8-7b1c-7e2d-8f3a-00000000000a',
  '0190f5a8-7b1c-7e2d-8f3a-00000000000b',
] as const;
const OLD_NODE = '0190f5a8-7b1c-7e2d-8f3a-00000000000c';
const DIGEST = `sha256:${'c'.repeat(64)}`;
const BUILT = `sha256:${'b'.repeat(64)}`;
const COMMIT = 'f'.repeat(40);
const REGISTRY = 'cp.example.com/0190f5a8-7b1c-7e2d-8f3a-00000000000e';
const NOW = new Date('2026-11-05T12:00:00Z');
const AGENT_NAME = /^sk-[a-z0-9-]{1,60}$/;
const AGENT_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
/** What a node's route serves in maintenance, in the simulated world. */
const PAGE = 'maintenance page';

const full: ShipkeepConfig = {
  version: 1,
  name: 'billing-api',
  build: { type: 'image', image: 'ghcr.io/acme/billing:1.4.2' },
  run: {
    port: 3000,
    command: ['node', 'main.js'],
    healthcheck: { path: '/health', start_period: '20s' },
  },
  release: { command: ['node', 'migrate.js'], timeout: '2m' },
  resources: { cpu: '0.5', memory: '512Mi' },
  scale: { replicas: 2 },
  domains: ['api.acme.example.com'],
  env: { LOG_LEVEL: 'info' },
  secrets: ['DATABASE_URL'],
};
const minimal: ShipkeepConfig = {
  version: 1,
  name: 'billing-api',
  build: { type: 'image', image: 'ghcr.io/acme/billing:1.4.2' },
  run: { port: 8080 },
};

/** The release serving before the deployment: one replica on NODES[0], one on OLD_NODE. */
const previous: Allocation[] = [
  { index: 0, nodeId: NODES[0], container: containerName(APP, 1, 0), port: 3000 },
  { index: 1, nodeId: OLD_NODE, container: containerName(APP, 1, 1), port: 3000 },
];

interface World {
  deployment: DeploymentRecord;
  pinned: string | null;
  /** The release's image and commit: a build pushes that tag, at that commit. */
  image: string;
  commit: string | null;
  allocations: Allocation[];
  steps: Map<string, StepOutcome>;
  routes: Map<string, string[]>;
  /** The hostnames each node's route matches: a restored route must match the previous ones. */
  hosts: Map<string, string[]>;
  /** The domains of the release serving before the deployment. */
  previousHosts: string[];
  stopped: Set<string>;
  executed: PipelineStep[];
  states: DeploymentState[];
}

function context(world: World, config: ShipkeepConfig): PipelineContext {
  return {
    deployment: world.deployment,
    application: APP,
    release: {
      id: '0190f5a8-7b1c-7e2d-8f3a-0000000000r2',
      number: 2,
      image: world.image,
      pinnedImage: world.pinned,
      config,
      commitSha: world.commit,
    },
    allocations: world.allocations,
    previous,
    previousHosts: world.previousHosts,
    steps: world.steps,
  };
}

/** Fake agents: each step succeeds unless `inject` says otherwise, with its side effects. */
function execute(
  world: World,
  step: PipelineStep,
  inject?: (step: PipelineStep) => StepOutcome | undefined,
) {
  world.executed.push(step);
  const injected = inject?.(step);
  if (injected) {
    world.steps.set(step.key, injected);
    return;
  }
  const outcome: StepOutcome =
    step.kind === 'create_container'
      ? { state: 'succeeded', containerId: `id-${step.container.name}` }
      : step.kind === 'health_check'
        ? { state: 'succeeded', healthy: true }
        : step.kind === 'run_release_task'
          ? { state: 'succeeded', exitCode: 0 }
          : step.kind === 'build_image'
            ? { state: 'succeeded', imageDigest: BUILT }
            : { state: 'succeeded' };
  if (step.kind === 'upsert_route') {
    world.routes.set(
      step.nodeId,
      step.maintenance ? [PAGE] : step.upstreams.map((u) => u.container),
    );
    world.hosts.set(step.nodeId, [...step.hosts]);
  }
  if (step.kind === 'remove_route') {
    world.routes.delete(step.nodeId);
    world.hosts.delete(step.nodeId);
  }
  if (step.kind === 'stop_container' || step.kind === 'remove_container')
    world.stopped.add(step.container);
  world.steps.set(step.key, outcome);
}

function simulate(
  config: ShipkeepConfig,
  inject?: (step: PipelineStep) => StepOutcome | undefined,
  planned: DeploymentRecord['plan'] = { build: false, release: config.release !== undefined },
  /** What the routes serve before the deployment: the replicas, or the maintenance page. */
  serving: 'replicas' | 'page' = 'replicas',
  /** The domains of the release serving before the deployment: by default, the same ones. */
  previousHosts: string[] = config.domains ?? [],
) {
  const world: World = {
    deployment: {
      id: '0190f5a8-7b1c-7e2d-8f3a-00000000000d',
      organizationId: '0190f5a8-7b1c-7e2d-8f3a-00000000000e',
      applicationId: APP.id,
      releaseId: '0190f5a8-7b1c-7e2d-8f3a-0000000000r2',
      state: 'queued',
      plan: planned,
      trigger: 'manual',
      actorId: null,
      startedAt: NOW,
      finishedAt: null,
      error: null,
    },
    pinned: null,
    image: planned.build ? `${REGISTRY}/${APP.id}:2` : 'ghcr.io/acme/billing:1.4.2',
    commit: planned.build ? COMMIT : null,
    allocations: [],
    steps: new Map(),
    routes: new Map(
      previousHosts.length
        ? [
            [NODES[0], serving === 'page' ? [PAGE] : [previous[0]?.container ?? '']],
            [OLD_NODE, serving === 'page' ? [PAGE] : [previous[1]?.container ?? '']],
          ]
        : [],
    ),
    hosts: new Map(
      previousHosts.length
        ? [
            [NODES[0], previousHosts],
            [OLD_NODE, previousHosts],
          ]
        : [],
    ),
    previousHosts,
    stopped: new Set(),
    executed: [],
    states: ['queued'],
  };
  for (let round = 0; round < 100; round++) {
    const decision = plan(context(world, config));
    switch (decision.kind) {
      case 'done':
        return world;
      case 'resolve_image':
        world.pinned = `ghcr.io/acme/billing@${DIGEST}`;
        break;
      case 'record_build':
        world.pinned = `${REGISTRY}/${APP.id}@${decision.digest}`;
        break;
      case 'place':
        world.allocations = Array.from({ length: decision.replicas }, (_, index) => ({
          index,
          nodeId: NODES[index % NODES.length] ?? NODES[0],
          container: containerName(APP, 2, index),
          port: config.run?.port ?? 0,
        }));
        break;
      case 'run':
        if (!decision.steps.length) throw new Error('the simulation never leaves steps in flight');
        for (const step of decision.steps) execute(world, step, inject);
        break;
      case 'advance':
        world.deployment = { ...world.deployment, ...advance(world.deployment, NOW) };
        world.states.push(world.deployment.state);
        break;
      case 'fail': {
        const stopped = stop(world.deployment, 'failed', decision.reason, NOW);
        const failedContext = context(world, config);
        world.deployment = { ...world.deployment, ...stopped.deployment };
        world.states.push('failed');
        for (const step of recovery(failedContext, stopped.routing)) execute(world, step);
        return world;
      }
    }
  }
  throw new Error('the pipeline did not finish');
}

describe('a build in the pipeline (ADR 0030)', () => {
  const built: ShipkeepConfig = {
    ...full,
    build: {
      type: 'dockerfile',
      context: './services/api/',
      dockerfile: 'Dockerfile.prod',
      args: { NODE_ENV: 'production' },
    },
  };
  const plan = { build: true, release: true };

  it("builds on the first replica's server, at the commit, then deploys the image it pushed", () => {
    const world = simulate(built, undefined, plan);
    expect(world.states).toEqual([
      'queued',
      'building',
      'built',
      'releasing',
      'scheduling',
      'starting',
      'health_checking',
      'switching',
      'draining',
      'succeeded',
    ]);
    const builds = world.executed.filter((step) => step.kind === 'build_image');
    expect(builds).toEqual([
      {
        kind: 'build_image',
        key: `d:${world.deployment.id}:build`,
        nodeId: NODES[0],
        builder: 'dockerfile',
        target: `${REGISTRY}/${APP.id}:2`,
        commit: COMMIT,
        // The paths as the agent reads them: no `.` segment, no empty one.
        context: 'services/api',
        dockerfile: 'Dockerfile.prod',
        args: { NODE_ENV: 'production' },
      },
    ]);
    // Every replica, and the release task, run the image the build pushed, pinned by its digest.
    const pulled = world.executed.flatMap((step) =>
      step.kind === 'pull_image' ? [step.image] : [],
    );
    expect(new Set(pulled)).toEqual(new Set([`${REGISTRY}/${APP.id}@${BUILT}`]));
    // Nothing was resolved from a registry: the build made the image.
    expect(world.executed.findIndex((step) => step.kind === 'build_image')).toBeLessThan(
      world.executed.findIndex((step) => step.kind === 'pull_image'),
    );
  });

  it('builds the root with the default Dockerfile when the configuration names neither', () => {
    const world = simulate(
      { ...full, build: { type: 'dockerfile', context: '.' } },
      undefined,
      plan,
    );
    expect(world.executed.find((step) => step.kind === 'build_image')).toMatchObject({
      context: '',
      dockerfile: 'Dockerfile',
    });
  });

  it('builds with Railpack or Nixpacks, which take no Dockerfile', () => {
    for (const builder of ['railpack', 'nixpacks'] as const) {
      const world = simulate(
        { ...full, build: { type: builder, context: './web/', args: { NODE_ENV: 'production' } } },
        undefined,
        plan,
      );
      expect(world.deployment.state).toBe('succeeded');
      expect(world.executed.find((step) => step.kind === 'build_image')).toMatchObject({
        builder,
        context: 'web',
        dockerfile: '',
        args: { NODE_ENV: 'production' },
      });
    }
  });

  it('says why a build failed, and deploys nothing', () => {
    for (const [reason, text] of [
      ['build_failed', /its output, on this deployment's page, says why/],
      ['build_timeout', /did not finish within its time limit/],
      ['builder_unavailable', /--migrate yes/],
    ] as const) {
      const world = simulate(
        built,
        (step) => (step.kind === 'build_image' ? { state: 'compensated', reason } : undefined),
        plan,
      );
      expect(world.deployment.state).toBe('failed');
      expect(world.deployment.error).toMatch(text);
      expect(world.executed.some((step) => step.kind === 'pull_image')).toBe(false);
    }
  });

  it('refuses a build that answered no digest, or a release without a commit', () => {
    const noDigest = simulate(
      built,
      (step) => (step.kind === 'build_image' ? { state: 'succeeded' } : undefined),
      plan,
    );
    expect(noDigest.deployment.error).toBe('The build answered no image digest.');
  });
});

describe('deployment pipeline', () => {
  it('runs every stage in SPEC 5.1 order and replaces the serving release', () => {
    const world = simulate(full);
    expect(world.states).toEqual([
      'queued',
      'releasing',
      'scheduling',
      'starting',
      'health_checking',
      'switching',
      'draining',
      'succeeded',
    ]);
    expect(Object.fromEntries(world.routes)).toEqual({
      [NODES[0]]: [containerName(APP, 2, 0)],
      [NODES[1]]: [containerName(APP, 2, 1)],
    });
    expect([...world.stopped].sort()).toEqual(previous.map((p) => p.container).sort());
    const kinds = world.executed.map((step) => step.kind);
    expect(kinds.filter((kind) => kind === 'pull_image')).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'run_release_task')).toHaveLength(1);
    expect(kinds.indexOf('upsert_route')).toBeGreaterThan(kinds.lastIndexOf('health_check'));
    expect(kinds.indexOf('stop_container')).toBeGreaterThan(kinds.lastIndexOf('upsert_route'));
    // Each replaced replica is stopped gracefully before it is removed.
    expect(kinds.filter((kind) => kind === 'remove_container')).toHaveLength(previous.length);
    expect(kinds.indexOf('remove_container')).toBeGreaterThan(kinds.indexOf('stop_container'));
  });

  describe('stopping an application (#256)', () => {
    const STOP = { build: false, release: false, stop: true };

    it('removes the routes and the serving replicas, and starts nothing', () => {
      const world = simulate(full, undefined, STOP);
      expect(world.states).toEqual(['queued', 'draining', 'succeeded']);
      expect(Object.fromEntries(world.routes)).toEqual({});
      expect([...world.stopped].sort()).toEqual(previous.map((p) => p.container).sort());
      const kinds = world.executed.map((step) => step.kind);
      expect([...new Set(kinds)].sort()).toEqual([
        'remove_container',
        'remove_route',
        'stop_container',
      ]);
      // One route per node that served, and each replica stopped gracefully before removal.
      expect(kinds.filter((kind) => kind === 'remove_route')).toHaveLength(2);
      expect(kinds.filter((kind) => kind === 'stop_container')).toHaveLength(previous.length);
      expect(kinds.indexOf('remove_container')).toBeGreaterThan(kinds.indexOf('stop_container'));
      // Nothing is resolved or placed: a stop does not need the registry or free capacity.
      expect(world.pinned).toBeNull();
      expect(world.allocations).toEqual([]);
      for (const step of world.executed) expect(step.key).toMatch(AGENT_KEY);
    });

    it('stops an application without domains the same way', () => {
      const world = simulate(minimal, undefined, STOP);
      expect(world.states).toEqual(['queued', 'draining', 'succeeded']);
      expect([...world.stopped].sort()).toEqual(previous.map((p) => p.container).sort());
    });

    it('fails when a replica cannot be stopped, and can be asked again', () => {
      const world = simulate(
        full,
        (step) =>
          step.kind === 'stop_container' && step.nodeId === OLD_NODE
            ? { state: 'failed' }
            : undefined,
        STOP,
      );
      expect(world.states).toEqual(['queued', 'draining', 'failed']);
      // Recovery has nothing to undo: no new replica exists and no route points at one.
      expect(world.executed.every((step) => step.kind !== 'create_container')).toBe(true);
      expect(world.executed.every((step) => step.kind !== 'upsert_route')).toBe(true);
    });
  });

  describe('maintenance (ADR 0025)', () => {
    const ENTER = { build: false, release: false, maintenance: 'enter' as const };
    const LEAVE = { build: false, release: false, maintenance: 'leave' as const };
    const routes = (world: World) => Object.fromEntries(world.routes);
    const failOn = (nodeId: string) => (step: PipelineStep) =>
      step.kind === 'upsert_route' && step.nodeId === nodeId
        ? ({ state: 'failed' } as const)
        : undefined;

    it('puts the page on the route of every node that hosts a replica, and keeps them', () => {
      const world = simulate(full, undefined, ENTER);
      expect(world.states).toEqual(['queued', 'switching', 'succeeded']);
      expect(routes(world)).toEqual({ [NODES[0]]: [PAGE], [OLD_NODE]: [PAGE] });
      // Only the routes change: nothing is resolved, placed, started or stopped.
      expect(world.executed.map((step) => step.kind)).toEqual(['upsert_route', 'upsert_route']);
      expect(world.stopped.size).toBe(0);
      expect(world.pinned).toBeNull();
      expect(world.allocations).toEqual([]);
      for (const step of world.executed) {
        expect(step).toMatchObject({ maintenance: true, upstreams: [], hosts: full.domains });
        // The requests the replicas serve finish before the switch succeeds.
        if (step.kind === 'upsert_route') expect(step.drainMs).toBeGreaterThan(0);
        expect(step.key).toMatch(AGENT_KEY);
      }
    });

    it('puts the replicas back when it leaves, with nothing to drain', () => {
      // The routes serve the page before: the test sees them change.
      const world = simulate(full, undefined, LEAVE, 'page');
      expect(world.states).toEqual(['queued', 'switching', 'succeeded']);
      expect(routes(world)).toEqual({
        [NODES[0]]: [previous[0]?.container],
        [OLD_NODE]: [previous[1]?.container],
      });
      expect(world.stopped.size).toBe(0);
      expect(world.executed).toHaveLength(2);
      for (const step of world.executed) {
        expect(step).not.toHaveProperty('maintenance');
        if (step.kind === 'upsert_route') expect(step.drainMs).toBe(0);
      }
    });

    it('puts the replicas back on every node when entering is interrupted', () => {
      const world = simulate(full, failOn(OLD_NODE), ENTER);
      expect(world.states).toEqual(['queued', 'switching', 'failed']);
      expect(routes(world)).toEqual({
        [NODES[0]]: [previous[0]?.container],
        [OLD_NODE]: [previous[1]?.container],
      });
      // Nothing to clean up: no replica was created, and none is stopped.
      expect(world.executed.some((step) => step.kind === 'remove_container')).toBe(false);
      expect(world.stopped.size).toBe(0);
    });

    it('puts the page back on every node when leaving is interrupted', () => {
      const world = simulate(full, failOn(OLD_NODE), LEAVE);
      expect(world.states).toEqual(['queued', 'switching', 'failed']);
      expect(routes(world)).toEqual({ [NODES[0]]: [PAGE], [OLD_NODE]: [PAGE] });
      expect(world.stopped.size).toBe(0);
    });

    it('has no route to change without domains', () => {
      const world = simulate(minimal, undefined, ENTER);
      expect(world.states).toEqual(['queued', 'switching', 'succeeded']);
      expect(world.executed).toEqual([]);
    });
  });

  it('builds agent-valid keys, names and container plans', () => {
    const world = simulate(full);
    for (const step of world.executed) {
      expect(step.key).toMatch(AGENT_KEY);
      if (step.kind === 'create_container' || step.kind === 'run_release_task') {
        expect(step.container.name).toMatch(AGENT_NAME);
        expect(step.container.network).toMatch(AGENT_NAME);
        expect(step.container.image).toBe(`ghcr.io/acme/billing@${DIGEST}`);
        expect(step.container.secrets).toEqual(['DATABASE_URL']);
        expect(Object.keys(step.container.labels).every((label) => !label.startsWith('sk.'))).toBe(
          true,
        );
      }
    }
    const create = world.executed.find((step) => step.kind === 'create_container');
    expect(create).toMatchObject({
      container: {
        command: ['node', 'main.js'],
        port: 3000,
        cpuMillis: 500,
        memoryBytes: 536_870_912,
        restart: 'always',
      },
    });
    const task = world.executed.find((step) => step.kind === 'run_release_task');
    expect(task).toMatchObject({
      container: { command: ['node', 'migrate.js'], port: null, restart: 'never' },
      timeoutMs: 120_000,
    });
  });

  it('skips the release task, health checks and routing when the configuration has none', () => {
    const world = simulate(minimal);
    expect(world.states).toEqual([
      'queued',
      'scheduling',
      'starting',
      'health_checking',
      'switching',
      'draining',
      'succeeded',
    ]);
    const kinds = new Set(world.executed.map((step) => step.kind));
    expect(
      kinds.has('run_release_task') || kinds.has('health_check') || kinds.has('upsert_route'),
    ).toBe(false);
    // Without domains the old routes go away with the old replicas.
    expect(world.routes.size).toBe(0);
  });

  describe('what a failed step says (issue #265)', () => {
    const failing = (kind: string, outcome: StepOutcome) =>
      simulate(full, (step) => (step.kind === kind ? outcome : undefined)).deployment.error;

    it('says why the image could not be pulled, in words that tell what to check', () => {
      expect(failing('pull_image', { state: 'compensated', reason: 'registry_denied' })).toBe(
        'The server could not pull the image: the registry refused it. The image is private, the stored credentials are wrong, or it does not exist.',
      );
      expect(failing('pull_image', { state: 'compensated', reason: 'image_not_found' })).toBe(
        'The server could not pull the image: the registry does not have it.',
      );
      expect(failing('pull_image', { state: 'compensated', reason: 'registry_unreachable' })).toBe(
        'The server could not pull the image: it could not reach the registry.',
      );
      expect(failing('pull_image', { state: 'compensated', reason: 'registry_untrusted' })).toBe(
        "The server could not pull the image: it does not trust the registry's certificate.",
      );
      expect(failing('pull_image', { state: 'failed', reason: 'disk_full' })).toBe(
        'The server could not pull the image: its disk is full.',
      );
      expect(failing('pull_image', { state: 'compensated', reason: 'egress_unguarded' })).toBe(
        "The server refused to pull the image: its Docker daemon does not go through Shipkeep's egress proxy, which keeps a registry from reaching the server's own network. Run the server installer again with --migrate yes to restore it.",
      );
    });

    // After a restore from an older backup, the next release reuses a number, and its name is
    // held by the container of a deployment the backup does not know (issue #501).
    it('says what to do when the container name is taken', () => {
      expect(
        failing('create_container', { state: 'compensated', reason: 'container_name_taken' }),
      ).toBe(
        'The server did not create the container: another container already has its name. After a restore from an older backup, it is likely the container of a deployment that the backup does not know, and each such deployment makes one more attempt fail: deploy again until one succeeds. That container then shows as untracked on the page of its server, where it can be removed once you have checked that it is no longer needed.',
      );
    });

    it('keeps the step and its fixed text for the other reasons', () => {
      expect(failing('pull_image', { state: 'failed', reason: 'invalid_input' })).toBe(
        'Step pull failed: invalid action input',
      );
      expect(failing('pull_image', { state: 'compensated', reason: 'action_failed' })).toBe(
        'Step pull compensated: action failed',
      );
      expect(failing('pull_image', { state: 'expired', reason: null })).toBe('Step pull expired.');
    });

    it('never repeats a text the agent sent that it does not know', () => {
      expect(failing('pull_image', { state: 'failed', reason: 'unknown' })).toBe(
        'Step pull failed.',
      );
    });

    it('does not read a pull cause into another step', () => {
      expect(failing('ensure_network', { state: 'failed', reason: 'registry_denied' })).toBe(
        'Step net failed: registry refused the pull',
      );
    });
  });

  it('leaves the previous release serving when any step before draining fails', () => {
    const keys = simulate(full).executed.map((step) => step);
    for (const target of keys) {
      const world = simulate(full, (step) =>
        step.key === target.key ? { state: 'failed', reason: 'action_failed' } : undefined,
      );
      expect(world.deployment.state, target.key).toBe('failed');
      expect(world.deployment.error, target.key).toMatch(/^Step [a-z-]+ failed: action failed$/);
      if (
        target.kind === 'stop_container' ||
        target.kind === 'remove_container' ||
        target.kind === 'remove_route'
      ) {
        // Draining already switched traffic: the new release keeps serving.
        expect(world.routes.get(NODES[0]), target.key).toEqual([containerName(APP, 2, 0)]);
        continue;
      }
      expect(Object.fromEntries(world.routes), target.key).toEqual({
        [NODES[0]]: [previous[0]?.container],
        [OLD_NODE]: [previous[1]?.container],
      });
      expect(world.stopped.has(previous[0]?.container ?? ''), target.key).toBe(false);
      expect(world.stopped.has(previous[1]?.container ?? ''), target.key).toBe(false);
      // New replicas that were created are stopped again.
      for (const step of world.executed.filter((s) => s.kind === 'create_container'))
        if (world.steps.get(step.key)?.state === 'succeeded')
          expect(world.stopped.has(step.container.name), target.key).toBe(true);
    }
  });

  // Issue #485: the restored route matches the previous release's hostnames, never the new ones.
  it('restores the previous hostnames when a deployment that changes its domains fails', () => {
    const renamed: ShipkeepConfig = { ...full, domains: ['new.acme.example.com'] };
    // The switch reached NODES[0], then failed on NODES[1].
    const world = simulate(
      renamed,
      (step) =>
        step.kind === 'upsert_route' && step.nodeId === NODES[1]
          ? { state: 'failed', reason: 'action_failed' }
          : undefined,
      undefined,
      'replicas',
      ['old.acme.example.com'],
    );
    expect(world.deployment.state).toBe('failed');
    expect(Object.fromEntries(world.hosts)).toEqual({
      [NODES[0]]: ['old.acme.example.com'],
      [OLD_NODE]: ['old.acme.example.com'],
    });
    expect(Object.fromEntries(world.routes)).toEqual({
      [NODES[0]]: [previous[0]?.container],
      [OLD_NODE]: [previous[1]?.container],
    });
  });

  it('removes the route a failed deployment added when the previous release had no domain', () => {
    const world = simulate(
      full,
      (step) =>
        step.kind === 'upsert_route' && step.nodeId === NODES[1]
          ? { state: 'failed', reason: 'action_failed' }
          : undefined,
      undefined,
      'replicas',
      [],
    );
    expect(world.deployment.state).toBe('failed');
    expect(Object.fromEntries(world.hosts)).toEqual({});
    expect(Object.fromEntries(world.routes)).toEqual({});
  });

  it('fails on a non-zero release exit, an unhealthy replica or a missing container id', () => {
    const exit = simulate(full, (step) =>
      step.kind === 'run_release_task' ? { state: 'succeeded', exitCode: 3 } : undefined,
    );
    expect(exit.deployment).toMatchObject({
      state: 'failed',
      error: 'The release command exited with code 3.',
    });
    const unhealthy = simulate(full, (step) =>
      step.kind === 'health_check' ? { state: 'succeeded', healthy: false } : undefined,
    );
    expect(unhealthy.deployment).toMatchObject({
      state: 'failed',
      error: 'A replica did not become healthy.',
    });
    const noId = simulate(minimal, (step) =>
      step.kind === 'create_container' ? { state: 'succeeded' } : undefined,
    );
    expect(noId.deployment).toMatchObject({
      state: 'failed',
      error: 'The agent returned no container id.',
    });
  });

  it('waits while actions are in flight and enqueues nothing twice', () => {
    const world = simulate(minimal);
    const base = context(
      { ...world, deployment: { ...world.deployment, state: 'starting', finishedAt: null } },
      minimal,
    );
    const running = new Map(base.steps);
    for (const [stepKey] of running)
      if (stepKey.includes(':start:')) running.set(stepKey, { state: 'running' });
    expect(plan({ ...base, steps: running })).toEqual({ kind: 'run', steps: [] });
    const fresh = plan({ ...base, steps: new Map() });
    expect(fresh.kind).toBe('run');
    if (fresh.kind === 'run')
      expect(new Set(fresh.steps.map((s) => s.key)).size).toBe(fresh.steps.length);
  });

  it('places replicas from the configuration, and builds only a release that has a commit', () => {
    const world = simulate(minimal);
    const base = context(
      {
        ...world,
        allocations: [],
        deployment: { ...world.deployment, state: 'scheduling', finishedAt: null },
      },
      full,
    );
    expect(plan(base)).toEqual({ kind: 'place', replicas: 2 });
    const building = { ...base, deployment: { ...base.deployment, state: 'building' as const } };
    // Already built: on to the next stage. Not yet: placed first, on the first replica's server.
    expect(plan(building)).toEqual({ kind: 'advance' });
    const unbuilt = { ...building, release: { ...building.release, pinnedImage: null } };
    expect(plan(unbuilt)).toEqual({ kind: 'place', replicas: 2 });
    expect(plan({ ...unbuilt, allocations: world.allocations })).toEqual({
      kind: 'fail',
      reason: 'The release names no commit to build.',
    });
    expect(plan({ ...base, deployment: { ...base.deployment, state: 'succeeded' } })).toEqual({
      kind: 'done',
    });
  });
});
