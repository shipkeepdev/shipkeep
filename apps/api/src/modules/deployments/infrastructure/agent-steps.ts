import { create } from '@bufbuild/protobuf';
import { type Duration, DurationSchema } from '@bufbuild/protobuf/wkt';
import { ConflictError, type Secret } from '@shipkeep/domain';
import {
  type ActionRequest,
  type ContainerSpec,
  ContainerSpecSchema,
  CreateContainerSchema,
  EnsureNetworkSchema,
  HealthCheckSchema,
  PortMapping_Protocol,
  PullImageSchema,
  RemoveContainerSchema,
  RemoveRouteSchema,
  RestartPolicy_Mode,
  RunReleaseTaskSchema,
  StartContainerSchema,
  StopContainerSchema,
  TlsMode,
  UpsertRouteSchema,
} from '@shipkeep/proto-ts';

import type { ContainerPlan } from '../domain/container-plan';
import type { PipelineStep } from '../domain/pipeline';

/** Decrypted secret values of the environment, by name (SECRET_STORE.values). */
export type SecretValues = ReadonlyMap<
  string,
  { readonly version: number; readonly value: Secret }
>;

/**
 * A planner step as the agent action it stands for (SPEC 3.3). Secret values are injected here,
 * at enqueue time, and only travel inside the encrypted action payload over mTLS (SPEC 9).
 */
export function agentAction(step: PipelineStep, secrets: SecretValues): ActionRequest['action'] {
  switch (step.kind) {
    case 'ensure_network':
      return { case: 'ensureNetwork', value: create(EnsureNetworkSchema, { name: step.network }) };
    case 'pull_image':
      return { case: 'pullImage', value: create(PullImageSchema, { imageRef: step.image }) };
    case 'run_release_task':
      return {
        case: 'runReleaseTask',
        value: create(RunReleaseTaskSchema, {
          spec: containerSpec(step.container, secrets),
          timeout: duration(step.timeoutMs),
        }),
      };
    case 'create_container':
      return {
        case: 'createContainer',
        value: create(CreateContainerSchema, { spec: containerSpec(step.container, secrets) }),
      };
    case 'start_container':
      return {
        case: 'startContainer',
        value: create(StartContainerSchema, { containerId: step.containerId }),
      };
    case 'health_check':
      return {
        case: 'healthCheck',
        value: create(HealthCheckSchema, {
          containerId: step.containerId,
          spec: {
            probe: { case: 'httpPath', value: step.health.path },
            interval: duration(step.health.intervalMs),
            timeout: duration(step.health.timeoutMs),
            startPeriod: duration(step.health.startPeriodMs),
            healthyThreshold: step.health.healthyThreshold,
          },
          deadline: duration(step.deadlineMs),
        }),
      };
    case 'upsert_route':
      return {
        case: 'upsertRoute',
        value: create(UpsertRouteSchema, {
          route: {
            routeId: step.routeId,
            hosts: [...step.hosts],
            upstreams: step.upstreams.map((upstream) => ({
              nodeId: step.nodeId,
              container: upstream.container,
              port: upstream.port,
            })),
            tlsMode: TlsMode.AUTO_HTTP,
            drainTimeout: duration(step.drainMs),
          },
        }),
      };
    case 'remove_route':
      return {
        case: 'removeRoute',
        value: create(RemoveRouteSchema, {
          routeId: step.routeId,
          drainTimeout: duration(step.drainMs),
        }),
      };
    case 'remove_container':
      return {
        case: 'removeContainer',
        value: create(RemoveContainerSchema, { containerId: step.container }),
      };
    case 'stop_container':
      return {
        case: 'stopContainer',
        value: create(StopContainerSchema, {
          containerId: step.container,
          stopTimeout: duration(step.timeoutMs),
        }),
      };
  }
}

function containerSpec(plan: ContainerPlan, secrets: SecretValues): ContainerSpec {
  const missing = plan.secrets.filter((name) => !secrets.has(name));
  if (missing.length)
    throw new ConflictError('secrets_missing', 'A secret the release references is not set.', {
      missing,
    });
  return create(ContainerSpecSchema, {
    name: plan.name,
    imageRef: plan.image,
    command: [...plan.command],
    env: Object.entries(plan.env).map(([name, value]) => ({ name, value })),
    secrets: plan.secrets.map((name) => {
      const secret = secrets.get(name);
      return {
        name,
        version: secret?.version ?? 0,
        value: new TextEncoder().encode(secret?.value.expose() ?? ''),
      };
    }),
    ports:
      plan.port === null
        ? []
        : [{ containerPort: plan.port, hostPort: 0, protocol: PortMapping_Protocol.TCP }],
    resources: { cpuMillis: plan.cpuMillis, memoryBytes: BigInt(plan.memoryBytes), pidsLimit: 0 },
    labels: { ...plan.labels },
    network: plan.network,
    restartPolicy: {
      mode: plan.restart === 'always' ? RestartPolicy_Mode.ALWAYS : RestartPolicy_Mode.NEVER,
    },
  });
}

function duration(milliseconds: number): Duration {
  return create(DurationSchema, {
    seconds: BigInt(Math.floor(milliseconds / 1000)),
    nanos: (milliseconds % 1000) * 1_000_000,
  });
}
