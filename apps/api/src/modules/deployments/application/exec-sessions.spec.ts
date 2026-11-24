import {
  ConflictError,
  type DomainEvent,
  InvalidInputError,
  NotFoundError,
} from '@shipkeep/domain';
import { describe, expect, it, vi } from 'vitest';

import type { DomainEventBus } from '../../../platform/events/domain-event-bus';
import type { ApplicationStore } from '../../apps/application/ports';
import type { Application } from '../../apps/domain/application';
import type { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import type { ResourceSecurityContext } from '../../identity/application/resource-security-context';
import type { TenantAccess } from '../../organizations/application/tenant-access';
import type { ReplicaStatus } from '../domain/observations';

import { ExecSessionRegistry } from '../../fleet/application/exec-relay';
import type { FleetTransaction } from '../../fleet/application/ports';

import { ExecSessions } from './exec-sessions';
import type { ActionQueue, DeploymentTransaction, ObservationStore } from './ports';

const ORG = '019d0000-0000-7000-8000-00000000000a';
const target = {
  organizationId: ORG,
  projectId: '019d0000-0000-7000-8000-00000000000b',
  environmentId: '019d0000-0000-7000-8000-00000000000c',
};
const APP = '019d0000-0000-7000-8000-0000000000a1';
const NODE = '019d0000-0000-7000-8000-0000000000e1';
const OTHER_NODE = '019d0000-0000-7000-8000-0000000000e2';
const USER = '019d0000-0000-7000-8000-0000000000f1';
const NOW = new Date('2026-11-24T12:00:00Z');
const context = { userId: USER, ip: '203.0.113.7' } as ResourceSecurityContext;

const application = { id: APP, ...target, name: 'web' } as unknown as Application;

function replica(overrides: Partial<ReplicaStatus>): ReplicaStatus {
  return {
    id: 'a1',
    releaseId: '019d0000-0000-7000-8000-0000000000c1',
    replica: 0,
    nodeId: NODE,
    nodeName: 'edge-1',
    container: 'sk-web-0000000000a1-r1-0',
    state: 'running',
    stopReason: null,
    observedAt: NOW,
    ...overrides,
  };
}

function world(options: { replicas?: ReplicaStatus[]; denied?: boolean; app?: boolean } = {}) {
  const queued: Parameters<ActionQueue['enqueue']>[0][] = [];
  const published: DomainEvent[] = [];
  const order: string[] = [];
  const registry = new ExecSessionRegistry(
    {
      runTenant: (_org: string, work: () => Promise<unknown>) => work(),
    } as unknown as FleetTransaction,
    { publish: () => Promise.resolve() } as unknown as DomainEventBus,
  );
  const service = new ExecSessions(
    {
      runTenant: (_org: string, work: () => Promise<unknown>) => work(),
    } as unknown as DeploymentTransaction,
    {
      find: () => Promise.resolve(options.app === false ? undefined : application),
    } as unknown as ApplicationStore,
    {
      forApplication: () => Promise.resolve(options.replicas ?? [replica({})]),
    } as unknown as ObservationStore,
    {
      enqueue: (input: Parameters<ActionQueue['enqueue']>[0]) => {
        order.push('action');
        queued.push(input);
        return Promise.resolve({ id: 'x', created: true });
      },
    },
    registry,
    {
      run: (_context: unknown, work: () => Promise<unknown>) => work(),
    } as unknown as AccountMutationAuthority,
    {
      require: () =>
        options.denied ? Promise.reject(new NotFoundError('resource')) : Promise.resolve(),
    } as unknown as TenantAccess,
    {
      publish: (batch: DomainEvent[]) => {
        order.push('audit');
        published.push(...batch);
        return Promise.resolve();
      },
    } as unknown as DomainEventBus,
  );
  return { service, queued, published, registry, order };
}

describe('opening an exec session (SPEC 3.1)', () => {
  it('queues the agent action for the running replica, audits it, and waits for both sides', async () => {
    const w = world();
    const session = await w.service.open(
      context,
      target,
      APP,
      { argv: ['psql', 'secret-pw'] },
      NOW,
    );
    expect(session).toMatchObject({
      organizationId: ORG,
      applicationId: APP,
      userId: USER,
      nodeId: NODE,
      container: 'sk-web-0000000000a1-r1-0',
      tty: true,
      attachBy: new Date(NOW.getTime() + 60_000),
      endsAt: new Date(NOW.getTime() + 60_000 + 30 * 60_000),
    });
    expect(w.order).toEqual(['action', 'audit']);
    const action = w.queued.at(0);
    expect(action).toMatchObject({
      organizationId: ORG,
      nodeId: NODE,
      idempotencyKey: `exec:${session.id}`,
      // The action expires with the join window, never hours later.
      deadline: session.attachBy,
    });
    expect(action?.origin).toBeUndefined();
    expect(action?.action.case).toBe('execSession');
    const value = action?.action.case === 'execSession' ? action.action.value : undefined;
    expect(value).toMatchObject({
      containerId: 'sk-web-0000000000a1-r1-0',
      argv: ['psql', 'secret-pw'],
      tty: true,
      sessionId: session.id,
    });
    expect(value?.timeLimit?.seconds).toBe(1800n);
    const [event] = w.published;
    expect(event).toMatchObject({
      type: 'exec.session.opened',
      organizationId: ORG,
      target: { type: 'exec_session', id: session.id },
      payload: {
        projectId: target.projectId,
        environmentId: target.environmentId,
        applicationId: APP,
        nodeId: NODE,
        replica: 0,
        tty: true,
        minutes: 30,
        program: 'psql',
        arguments: 1,
      },
    });
    // What the person typed never reaches the audit log.
    expect(JSON.stringify(event)).not.toContain('secret-pw');
    expect(w.registry.pending(session.id)).toEqual(session);
  });

  it('takes the running release of the replica asked for', async () => {
    const w = world({
      replicas: [
        replica({ replica: 0, nodeId: OTHER_NODE }),
        replica({ replica: 1, state: 'exited', container: 'sk-web-old-r2' }),
        replica({
          replica: 1,
          releaseId: '019d0000-0000-7000-8000-0000000000c2',
          container: 'sk-web-new-r2',
        }),
      ],
    });
    const session = await w.service.open(context, target, APP, { replica: 1 }, NOW);
    expect(session.container).toBe('sk-web-new-r2');
    expect(session.nodeId).toBe(NODE);
  });

  it('refuses a replica last seen too long ago: its server may be down', async () => {
    const w = world({ replicas: [replica({ observedAt: new Date(NOW.getTime() - 3 * 60_000) })] });
    await expect(w.service.open(context, target, APP, {}, NOW)).rejects.toBeInstanceOf(
      ConflictError,
    );
    const unseen = world({ replicas: [replica({ observedAt: null })] });
    await expect(unseen.service.open(context, target, APP, {}, NOW)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect([...w.queued, ...unseen.queued]).toEqual([]);
  });

  it('caps the sessions waiting for one person', async () => {
    vi.useFakeTimers();
    try {
      const w = world();
      for (let i = 0; i < 4; i++) await w.service.open(context, target, APP, {}, NOW);
      await expect(w.service.open(context, target, APP, {}, NOW)).rejects.toMatchObject({
        code: 'exec_sessions_limit',
      });
      expect(w.queued).toHaveLength(4);
      // Once their join window passed, they no longer count.
      vi.advanceTimersByTime(60_000);
      await w.service.open(context, target, APP, {}, NOW);
      expect(w.queued).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a replica that does not run, before queueing or auditing anything', async () => {
    const w = world({ replicas: [replica({ state: 'exited' })] });
    await expect(w.service.open(context, target, APP, {}, NOW)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(w.queued).toEqual([]);
    expect(w.published).toEqual([]);
  });

  it('refuses without the permission, an unknown application, or an invalid request', async () => {
    const denied = world({ denied: true });
    await expect(denied.service.open(context, target, APP, {}, NOW)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const missing = world({ app: false });
    await expect(missing.service.open(context, target, APP, {}, NOW)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const invalid = world();
    await expect(
      invalid.service.open(context, target, APP, { argv: ['sh', '\u0000'] }, NOW),
    ).rejects.toBeInstanceOf(InvalidInputError);
    for (const w of [denied, missing, invalid]) {
      expect(w.queued).toEqual([]);
      expect(w.published).toEqual([]);
    }
  });

  it('is joinable only once its action and audit event are committed', async () => {
    const w = world();
    const failing = new ExecSessions(
      { runTenant: () => Promise.reject(new Error('commit failed')) },
      {} as ApplicationStore,
      {} as ObservationStore,
      { enqueue: () => Promise.reject(new Error('unused')) },
      w.registry,
      {
        run: (_c: unknown, work: () => Promise<unknown>) => work(),
      } as unknown as AccountMutationAuthority,
      { require: () => Promise.resolve() } as unknown as TenantAccess,
      { publish: () => Promise.resolve() } as unknown as DomainEventBus,
    );
    await expect(failing.open(context, target, APP, {}, NOW)).rejects.toThrow('commit failed');
    expect(w.registry.pending('anything')).toBeUndefined();
  });
});
