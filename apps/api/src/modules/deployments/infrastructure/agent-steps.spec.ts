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
      // The disk budget left out is 1 GiB (ADR 0022); the root stays writable by default.
      resources: { cpuMillis: 500, memoryBytes: 536_870_912n, diskBytes: 1_073_741_824n },
      readOnlyRootfs: false,
      mounts: [],
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

  it('sends the disk budget and, on request, a read-only root with a bounded /tmp (ADR 0022)', () => {
    const readOnly = containerPlan({
      config: {
        version: 1,
        name: 'billing-api',
        build: { type: 'image', image: 'ghcr.io/acme/billing:1.4.2' },
        run: { port: 3000, read_only_root: true },
        resources: { disk: '64Mi' },
      },
      image: IMAGE,
      name: 'sk-billing-api-0123456789ab-r2-0',
      network: 'sk-env-0190f5a87b1c7e2d8f3a0123456789ac',
      labels: {},
      task: false,
    });
    const action = wire(agentAction(step('create_container', { container: readOnly }), secrets));
    if (action.case !== 'createContainer') throw new Error(String(action.case));
    const spec = action.value.spec;
    expect(spec?.resources?.diskBytes).toBe(67_108_864n);
    expect(spec?.readOnlyRootfs).toBe(true);
    expect(
      spec?.mounts.map((mount) => [
        mount.containerPath,
        mount.readOnly,
        mount.source.case,
        mount.source.case === 'tmpfs'
          ? [mount.source.value.sizeBytes, mount.source.value.mode]
          : [],
      ]),
    ).toEqual([['/tmp', false, 'tmpfs', [67_108_864n, 0o1777]]]);
  });

  it('refuses to build a container whose secrets are not set', () => {
    expect(() => agentAction(step('create_container', { container }), new Map())).toThrow(
      expect.objectContaining({ code: 'secrets_missing', details: { missing: ['DATABASE_URL'] } }),
    );
  });

  describe('pulling from a private registry (ADR 0019)', () => {
    const EXPIRES = new Date('2026-11-05T13:00:00Z');
    const login = (server: string) => ({
      server,
      username: 'deploy-bot',
      password: new Secret('sk_test_fake_registry_password'),
    });
    const pull = (image: string, servers: string[]) => {
      const action = wire(
        agentAction(step('pull_image', { image }), secrets, {
          logins: new Map(servers.map((server) => [server, login(server)])),
          expiresAt: EXPIRES,
        }),
      );
      return action.case === 'pullImage' ? action.value : undefined;
    };

    it('sends the credentials stored for the registry the image names', () => {
      expect(pull(IMAGE, ['ghcr.io', 'registry.example.com'])).toMatchObject({
        imageRef: IMAGE,
        registryCredentials: {
          server: 'ghcr.io',
          username: 'deploy-bot',
          password: 'sk_test_fake_registry_password',
          expiresAt: { seconds: BigInt(EXPIRES.getTime() / 1000), nanos: 0 },
        },
      });
    });

    it('sends none of another registry, whatever its name looks like', () => {
      for (const servers of [
        [],
        ['registry.example.com'],
        // Neither a prefix, a port variant nor the repository owner is the registry.
        ['ghcr.io:443', 'ghcr.io.example.com', 'acme', 'docker.io'],
      ])
        expect(pull(IMAGE, servers)?.registryCredentials).toBeUndefined();
    });

    it('keeps the port of a registry apart from the same host without it', () => {
      const image = `registry.example.com:5000/acme/billing@sha256:${'c'.repeat(64)}`;
      expect(pull(image, ['registry.example.com'])?.registryCredentials).toBeUndefined();
      expect(pull(image, ['registry.example.com:5000'])?.registryCredentials?.server).toBe(
        'registry.example.com:5000',
      );
    });

    it('sends Docker Hub credentials for an image written without a registry', () => {
      const digest = `sha256:${'c'.repeat(64)}`;
      for (const image of [`nginx@${digest}`, `acme/billing@${digest}`])
        expect(pull(image, ['docker.io', 'ghcr.io'])?.registryCredentials).toMatchObject({
          server: 'docker.io',
        });
      // A namespace is not a registry: `acme` credentials never go to Docker Hub.
      expect(pull(`acme/billing@${digest}`, ['acme'])?.registryCredentials).toBeUndefined();
    });

    it('names the registry as the agent reads it when Docker Hub is written by its API host', () => {
      // Stored as docker.io, but the agent reads `registry-1.docker.io` in this reference and
      // accepts credentials for that name only.
      const image = `registry-1.docker.io/acme/private@sha256:${'c'.repeat(64)}`;
      expect(pull(image, ['docker.io'])?.registryCredentials).toMatchObject({
        server: 'registry-1.docker.io',
        username: 'deploy-bot',
      });
      expect(pull(image, ['ghcr.io'])?.registryCredentials).toBeUndefined();
    });

    it('sends no Docker Hub credentials to an agent that would refuse the whole pull', () => {
      const digest = `sha256:${'c'.repeat(64)}`;
      const toOldAgent = (image: string, servers: string[]) => {
        const action = wire(
          agentAction(step('pull_image', { image }), secrets, {
            logins: new Map(servers.map((server) => [server, login(server)])),
            expiresAt: EXPIRES,
            withoutDockerHub: new Set([NODE]),
          }),
        );
        return action.case === 'pullImage' ? action.value.registryCredentials : undefined;
      };
      // Without a registry host: the agents before the rule refuse `docker.io` for these.
      expect(toOldAgent(`nginx@${digest}`, ['docker.io'])).toBeUndefined();
      expect(toOldAgent(`acme/billing@${digest}`, ['docker.io'])).toBeUndefined();
      // A registry named by a host never needed the rule.
      expect(toOldAgent(IMAGE, ['ghcr.io'])).toMatchObject({ server: 'ghcr.io' });
      expect(
        toOldAgent(`registry-1.docker.io/acme/private@${digest}`, ['docker.io']),
      ).toMatchObject({ server: 'registry-1.docker.io' });
      // Another node, with a current agent, still gets them.
      const other = wire(
        agentAction(
          { ...step('pull_image', { image: `nginx@${digest}` }), nodeId: 'another-node' },
          secrets,
          {
            logins: new Map([['docker.io', login('docker.io')]]),
            expiresAt: EXPIRES,
            withoutDockerHub: new Set([NODE]),
          },
        ),
      );
      expect(other.case === 'pullImage' && other.value.registryCredentials?.server).toBe(
        'docker.io',
      );
    });

    it('sends none when no registry access is given', () => {
      const action = wire(agentAction(step('pull_image', { image: IMAGE }), secrets));
      expect(action.case === 'pullImage' && action.value.registryCredentials).toBeUndefined();
    });
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
      agentAction(step('remove_container', { container: container.name }), secrets),
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
      'removeContainer',
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
    const planned = plannedActions();
    // The application declares no `resources`: both containers carry the default limits, which
    // the agent requires (#301).
    const specs = planned.flatMap((action) =>
      action.case === 'createContainer' || action.case === 'runReleaseTask'
        ? [action.value.spec?.resources]
        : [],
    );
    expect(specs).toHaveLength(2);
    for (const resources of specs)
      expect(resources).toMatchObject({
        cpuMillis: 1000,
        memoryBytes: 536_870_912n,
        diskBytes: 1_073_741_824n,
      });
    const lines = planned.map(
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
