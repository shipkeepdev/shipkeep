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
const NOW = new Date('2026-11-05T12:00:00Z');
const AGENT_NAME = /^sk-[a-z0-9-]{1,60}$/;
const AGENT_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

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
  allocations: Allocation[];
  steps: Map<string, StepOutcome>;
  routes: Map<string, string[]>;
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
      pinnedImage: world.pinned,
      config,
    },
    allocations: world.allocations,
    previous,
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
          : { state: 'succeeded' };
  if (step.kind === 'upsert_route')
    world.routes.set(
      step.nodeId,
      step.upstreams.map((u) => u.container),
    );
  if (step.kind === 'remove_route') world.routes.delete(step.nodeId);
  if (step.kind === 'stop_container') world.stopped.add(step.container);
  world.steps.set(step.key, outcome);
}

function simulate(
  config: ShipkeepConfig,
  inject?: (step: PipelineStep) => StepOutcome | undefined,
) {
  const world: World = {
    deployment: {
      id: '0190f5a8-7b1c-7e2d-8f3a-00000000000d',
      organizationId: '0190f5a8-7b1c-7e2d-8f3a-00000000000e',
      applicationId: APP.id,
      releaseId: '0190f5a8-7b1c-7e2d-8f3a-0000000000r2',
      state: 'queued',
      plan: { build: false, release: config.release !== undefined },
      trigger: 'manual',
      actorId: null,
      startedAt: NOW,
      finishedAt: null,
      error: null,
    },
    pinned: null,
    allocations: [],
    steps: new Map(),
    routes: new Map([
      [NODES[0], [previous[0]?.container ?? '']],
      [OLD_NODE, [previous[1]?.container ?? '']],
    ]),
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

  it('leaves the previous release serving when any step before draining fails', () => {
    const keys = simulate(full).executed.map((step) => step);
    for (const target of keys) {
      const world = simulate(full, (step) =>
        step.key === target.key ? { state: 'failed', error: 'injected failure' } : undefined,
      );
      expect(world.deployment.state, target.key).toBe('failed');
      expect(world.deployment.error, target.key).toContain('injected failure');
      if (target.kind === 'stop_container' || target.kind === 'remove_route') {
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

  it('places replicas from the configuration and refuses builds', () => {
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
    expect(plan({ ...base, deployment: { ...base.deployment, state: 'building' } })).toMatchObject({
      kind: 'fail',
    });
    expect(plan({ ...base, deployment: { ...base.deployment, state: 'succeeded' } })).toEqual({
      kind: 'done',
    });
  });
});
