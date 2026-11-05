import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { Secret } from '@shipkeep/domain';
import { ActionRequestSchema, RestartPolicy_Mode, TlsMode } from '@shipkeep/proto-ts';
import { create } from '@bufbuild/protobuf';

import { containerPlan } from '../domain/container-plan';
import type { PipelineStep } from '../domain/pipeline';

import { agentAction, type SecretValues } from './agent-steps';
import { plannedActions } from './agent-steps.vectors.spec-helpers';

const NODE = '0190f5a8-7b1c-7e2d-8f3a-00000000000a';
const IMAGE = `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}`;
const container = containerPlan({
  config: {
    version: 1,
    name: 'billing-api',
    build: { type: 'image', image: 'ghcr.io/acme/billing:1.4.2' },
    run: { port: 3000, command: ['node', 'main.js'] },
    resources: { cpu: '0.5', memory: '512Mi' },
    env: { LOG_LEVEL: 'info' },
    secrets: ['DATABASE_URL'],
  },
  image: IMAGE,
  name: 'sk-billing-api-0123456789ab-r2-0',
  network: 'sk-env-0190f5a87b1c7e2d8f3a0123456789ac',
  labels: { 'shipkeep.application': 'app' },
  task: false,
});
const secrets: SecretValues = new Map([
  ['DATABASE_URL', { version: 3, value: new Secret('postgres://fixture:private@db/app') }],
]);
const step = <T extends PipelineStep['kind']>(
  kind: T,
  fields: Omit<Extract<PipelineStep, { kind: T }>, 'kind' | 'key' | 'nodeId'>,
) => ({ kind, key: `d:x:${kind}`, nodeId: NODE, ...fields }) as Extract<PipelineStep, { kind: T }>;

/** Round-trips through the wire format, as the action queue stores and delivers it. */
function wire(action: ReturnType<typeof agentAction>) {
  return fromBinary(
    ActionRequestSchema,
    toBinary(ActionRequestSchema, create(ActionRequestSchema, { action })),
  ).action;
}

describe('agentAction', () => {
  it('builds a confined container spec with secret values injected', () => {
    const action = wire(agentAction(step('create_container', { container }), secrets));
    expect(action.case).toBe('createContainer');
    if (action.case !== 'createContainer') return;
    const spec = action.value.spec;
    expect(spec).toMatchObject({
      name: container.name,
      imageRef: IMAGE,
      command: ['node', 'main.js'],
      env: [expect.objectContaining({ name: 'LOG_LEVEL', value: 'info' })],
      network: container.network,
      labels: { 'shipkeep.application': 'app' },
      resources: { cpuMillis: 500, memoryBytes: 536_870_912n },
      restartPolicy: { mode: RestartPolicy_Mode.ALWAYS },
    });
    expect(spec?.ports.map((port) => [port.containerPort, port.hostPort])).toEqual([[3000, 0]]);
    expect(
      spec?.secrets.map((secret) => [
        secret.name,
        secret.version,
        new TextDecoder().decode(secret.value),
      ]),
    ).toEqual([['DATABASE_URL', 3, 'postgres://fixture:private@db/app']]);
  });

  it('refuses to build a container whose secrets are not set', () => {
    expect(() => agentAction(step('create_container', { container }), new Map())).toThrow(
      expect.objectContaining({ code: 'secrets_missing', details: { missing: ['DATABASE_URL'] } }),
    );
  });

  it('maps every other step to its typed action', () => {
    const task = { ...container, port: null, restart: 'never' as const, secrets: [] };
    const actions = [
      agentAction(step('ensure_network', { network: container.network }), secrets),
      agentAction(step('pull_image', { image: IMAGE }), secrets),
      agentAction(step('run_release_task', { container: task, timeoutMs: 120_500 }), secrets),
      agentAction(step('start_container', { containerId: 'f'.repeat(64) }), secrets),
      agentAction(
        step('health_check', {
          containerId: 'f'.repeat(64),
          health: {
            path: '/health',
            port: 3000,
            intervalMs: 5_000,
            timeoutMs: 2_000,
            startPeriodMs: 20_000,
            healthyThreshold: 2,
          },
          deadlineMs: 140_000,
        }),
        secrets,
      ),
      agentAction(
        step('upsert_route', {
          routeId: 'app',
          hosts: ['api.acme.example.com'],
          upstreams: [{ container: container.name, port: 3000 }],
          drainMs: 30_000,
        }),
        secrets,
      ),
      agentAction(step('remove_route', { routeId: 'app', drainMs: 30_000 }), secrets),
      agentAction(
        step('stop_container', { container: container.name, timeoutMs: 10_000 }),
        secrets,
      ),
    ].map(wire);
    expect(actions.map((action) => action.case)).toEqual([
      'ensureNetwork',
      'pullImage',
      'runReleaseTask',
      'startContainer',
      'healthCheck',
      'upsertRoute',
      'removeRoute',
      'stopContainer',
    ]);
    const [, , release, , health, route] = actions;
    if (release.case === 'runReleaseTask') {
      expect(release.value.timeout).toMatchObject({ seconds: 120n, nanos: 500_000_000 });
      expect(release.value.spec?.ports).toEqual([]);
      expect(release.value.spec?.restartPolicy?.mode).toBe(RestartPolicy_Mode.NEVER);
    }
    if (health.case === 'healthCheck')
      expect(health.value.spec).toMatchObject({
        probe: { case: 'httpPath', value: '/health' },
        healthyThreshold: 2,
        startPeriod: { seconds: 20n },
      });
    if (route.case === 'upsertRoute')
      expect(route.value.route).toMatchObject({
        tlsMode: TlsMode.AUTO_HTTP,
        upstreams: [{ address: '', container: container.name, port: 3000, nodeId: NODE }],
      });
  });
});

describe('agent compatibility vectors', () => {
  it('matches the vectors the Go agent validates (agent/internal/actions)', async () => {
    // A full pipeline run, with a fixture secret: the Go test checks every action passes the
    // agent's own validation, so planner and agent cannot drift apart silently.
    const lines = plannedActions().map(
      (action) =>
        `${action.case ?? ''} ${Buffer.from(
          toBinary(ActionRequestSchema, create(ActionRequestSchema, { action })),
        ).toString('base64')}`,
    );
    await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot(
      '../../../../../../agent/internal/actions/testdata/control-plane-actions.txt',
    );
  });
});
