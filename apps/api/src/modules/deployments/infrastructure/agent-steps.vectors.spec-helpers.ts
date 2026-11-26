import type { ActionRequest } from '@shipkeep/proto-ts';
import { advance, Secret } from '@shipkeep/domain';

import { containerName } from '../domain/container-plan';
import {
  plan,
  type PipelineContext,
  type PipelineStep,
  type StepOutcome,
} from '../domain/pipeline';
import type { DeploymentRecord } from '../domain/release';

import { agentAction } from './agent-steps';

/**
 * Every action a full pipeline run sends, for the agent compatibility test. Test-only fixture:
 * fixed identifiers, a fixture secret, and fake outcomes for each step.
 */
export function plannedActions(): ActionRequest['action'][] {
  const application = {
    id: '0190f5a8-7b1c-7e2d-8f3a-0123456789ab',
    name: 'billing-api',
    environmentId: '0190f5a8-7b1c-7e2d-8f3a-0123456789ac',
  };
  const node = '0190f5a8-7b1c-7e2d-8f3a-00000000000a';
  let deployment: DeploymentRecord = {
    id: '0190f5a8-7b1c-7e2d-8f3a-00000000000d',
    organizationId: '0190f5a8-7b1c-7e2d-8f3a-00000000000e',
    applicationId: application.id,
    releaseId: '0190f5a8-7b1c-7e2d-8f3a-00000000000f',
    state: 'queued',
    plan: { build: false, release: true },
    trigger: 'manual',
    actorId: null,
    startedAt: new Date(0),
    finishedAt: null,
    error: null,
  };
  const steps = new Map<string, StepOutcome>();
  const sent: PipelineStep[] = [];
  // The previous release ran on another node: draining removes its route there.
  const previous = [
    {
      index: 0,
      nodeId: '0190f5a8-7b1c-7e2d-8f3a-00000000000b',
      container: containerName(application, 1, 0),
      port: 3000,
    },
  ];
  const allocations = [
    { index: 0, nodeId: node, container: containerName(application, 2, 0), port: 3000 },
  ];
  for (let round = 0; round < 50; round++) {
    const context: PipelineContext = {
      deployment,
      application,
      release: {
        id: deployment.releaseId,
        number: 2,
        pinnedImage: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}`,
        config: {
          version: 1,
          name: 'billing-api',
          build: { type: 'image', image: 'ghcr.io/acme/billing:1.4.2' },
          run: { port: 3000, command: ['node', 'main.js'], healthcheck: { path: '/health' } },
          release: { command: ['node', 'migrate.js'] },
          // No `resources`: the vectors carry the default limits, which the agent must accept.
          domains: ['api.acme.example.com'],
          env: { LOG_LEVEL: 'info' },
          secrets: ['DATABASE_URL'],
        },
      },
      allocations,
      previous,
      previousHosts: ['api.acme.example.com'],
      steps,
    };
    const decision = plan(context);
    if (decision.kind === 'done') break;
    if (decision.kind === 'advance')
      deployment = { ...deployment, ...advance(deployment, new Date(0)) };
    if (decision.kind === 'run')
      for (const step of decision.steps) {
        sent.push(step);
        steps.set(step.key, {
          state: 'succeeded',
          ...(step.kind === 'create_container' ? { containerId: 'f'.repeat(64) } : {}),
          ...(step.kind === 'health_check' ? { healthy: true } : {}),
          ...(step.kind === 'run_release_task' ? { exitCode: 0 } : {}),
        });
      }
  }
  const secrets = new Map([
    ['DATABASE_URL', { version: 1, value: new Secret('fixture-only-value') }],
  ]);
  return sent.map((step) => agentAction(step, secrets));
}

/**
 * The route actions of entering then leaving maintenance (ADR 0025), for the same compatibility
 * test: the agent must accept the page without upstream, and the replicas back.
 */
export function maintenanceActions(): ActionRequest['action'][] {
  const application = {
    id: '0190f5a8-7b1c-7e2d-8f3a-0123456789ab',
    name: 'billing-api',
    environmentId: '0190f5a8-7b1c-7e2d-8f3a-0123456789ac',
  };
  const serving = [
    {
      index: 0,
      nodeId: '0190f5a8-7b1c-7e2d-8f3a-00000000000a',
      container: containerName(application, 2, 0),
      port: 3000,
    },
  ];
  const sent: PipelineStep[] = [];
  for (const change of ['enter', 'leave'] as const) {
    let deployment: DeploymentRecord = {
      id:
        change === 'enter'
          ? '0190f5a8-7b1c-7e2d-8f3a-0000000000e1'
          : '0190f5a8-7b1c-7e2d-8f3a-0000000000e2',
      organizationId: '0190f5a8-7b1c-7e2d-8f3a-00000000000e',
      applicationId: application.id,
      releaseId: '0190f5a8-7b1c-7e2d-8f3a-00000000000f',
      state: 'queued',
      plan: { build: false, release: false, maintenance: change },
      trigger: 'manual',
      actorId: null,
      startedAt: new Date(0),
      finishedAt: null,
      error: null,
    };
    const steps = new Map<string, StepOutcome>();
    for (let round = 0; round < 10; round++) {
      const decision = plan({
        deployment,
        application,
        release: {
          id: deployment.releaseId,
          number: 2,
          pinnedImage: null,
          config: {
            version: 1,
            name: 'billing-api',
            build: { type: 'image', image: 'ghcr.io/acme/billing:1.4.2' },
            run: { port: 3000 },
            domains: ['api.acme.example.com'],
          },
        },
        allocations: [],
        previous: serving,
        previousHosts: ['api.acme.example.com'],
        steps,
      });
      if (decision.kind === 'done') break;
      if (decision.kind === 'advance')
        deployment = { ...deployment, ...advance(deployment, new Date(0)) };
      if (decision.kind === 'run')
        for (const step of decision.steps) {
          sent.push(step);
          steps.set(step.key, { state: 'succeeded' });
        }
    }
  }
  return sent.map((step) => agentAction(step, new Map()));
}
