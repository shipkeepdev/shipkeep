import type { DomainEvent } from '@shipkeep/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DomainEventBus } from '../../../platform/events/domain-event-bus';

import {
  type AgentFrame,
  type BrowserFrame,
  type ExecSession,
  ExecSessionRegistry,
  MAX_WAITING_FRAMES,
} from './exec-relay';
import type { FleetTransaction } from './ports';

const ORG = '019d0000-0000-7000-8000-00000000000a';
const NODE = '019d0000-0000-7000-8000-0000000000e1';
const USER = '019d0000-0000-7000-8000-0000000000f1';
const NOW = new Date('2026-11-24T12:00:00Z');

function session(id = '019d0000-0000-7000-8000-0000000000s1'): ExecSession {
  return {
    id,
    organizationId: ORG,
    projectId: '019d0000-0000-7000-8000-00000000000b',
    environmentId: '019d0000-0000-7000-8000-00000000000c',
    applicationId: '019d0000-0000-7000-8000-0000000000a1',
    userId: USER,
    nodeId: NODE,
    container: 'sk-web-r1-0',
    tty: true,
    attachBy: new Date(NOW.getTime() + 60_000),
    endsAt: new Date(NOW.getTime() + 31 * 60_000),
  };
}

function world() {
  const published: DomainEvent[] = [];
  const registry = new ExecSessionRegistry(
    {
      runTenant: (_org: string, work: () => Promise<unknown>) => work(),
    } as unknown as FleetTransaction,
    {
      publish: (batch: DomainEvent[]) => (published.push(...batch), Promise.resolve()),
    } as unknown as DomainEventBus,
  );
  const received: AgentFrame[] = [];
  let closed = false;
  const port = {
    send: (frame: AgentFrame) => (received.push(frame), Promise.resolve()),
    close: () => {
      closed = true;
    },
  };
  return { registry, published, received, port, closed: () => closed };
}

async function collect(frames: AsyncGenerator<BrowserFrame>): Promise<BrowserFrame[]> {
  const out: BrowserFrame[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

const node = { organizationId: ORG, nodeId: NODE };

afterEach(() => {
  vi.useRealTimers();
});

describe('the exec relay (SPEC 3.1)', () => {
  it('joins both sides, carries frames both ways, and audits the exit', async () => {
    const w = world();
    const s = session();
    w.registry.add(s, NOW);
    const browser = w.registry.joinBrowser(s.id, USER, w.port);
    const agent = w.registry.joinAgent(s.id, node);
    expect(browser).toBe(agent);
    expect(await agent?.bothJoined()).toBe(true);
    browser?.fromBrowser({ kind: 'stdin', data: new TextEncoder().encode('ls\n') });
    browser?.fromBrowser({ kind: 'resize', cols: 80, rows: 24 });
    const toAgent = agent?.toAgent();
    expect((await toAgent?.next())?.value).toEqual({
      kind: 'stdin',
      data: new TextEncoder().encode('ls\n'),
    });
    expect((await toAgent?.next())?.value).toEqual({ kind: 'resize', cols: 80, rows: 24 });
    await agent?.fromAgent({ kind: 'stdout', data: new TextEncoder().encode('file\n') });
    await agent?.fromAgent({ kind: 'exit', code: 3 });
    expect(w.received.map((frame) => frame.kind)).toEqual(['stdout', 'exit']);
    expect(w.closed()).toBe(true);
    // After an exit the command is gone: nothing more to stop.
    expect((await toAgent?.next())?.done).toBe(true);
    await Promise.resolve();
    expect(w.published).toHaveLength(1);
    expect(w.published[0]).toMatchObject({
      type: 'exec.session.ended',
      organizationId: ORG,
      actor: { kind: 'user', id: USER },
      target: { type: 'exec_session', id: s.id },
      payload: { reason: 'exited', exitCode: 3, nodeId: NODE },
    });
    expect(w.registry.pending(s.id)).toBeUndefined();
  });

  it('lets only its node, its person, and each of them once, join', () => {
    const w = world();
    const s = session();
    w.registry.add(s, NOW);
    expect(
      w.registry.joinAgent(s.id, {
        organizationId: ORG,
        nodeId: '019d0000-0000-7000-8000-0000000000e9',
      }),
    ).toBeUndefined();
    expect(
      w.registry.joinAgent(s.id, {
        organizationId: '019d0000-0000-7000-8000-0000000000ff',
        nodeId: NODE,
      }),
    ).toBeUndefined();
    expect(w.registry.joinAgent('019d0000-0000-7000-8000-000000000000', node)).toBeUndefined();
    expect(
      w.registry.joinBrowser(s.id, '019d0000-0000-7000-8000-0000000000f9', w.port),
    ).toBeUndefined();
    expect(w.registry.joinAgent(s.id, node)).toBeDefined();
    expect(w.registry.joinAgent(s.id, node)).toBeUndefined();
    expect(w.registry.joinBrowser(s.id, USER, w.port)).toBeDefined();
    expect(w.registry.joinBrowser(s.id, USER, w.port)).toBeUndefined();
  });

  it('ends a session nobody joined in time', async () => {
    vi.useFakeTimers();
    const w = world();
    const s = session();
    w.registry.add(s, NOW);
    const agent = w.registry.joinAgent(s.id, node);
    const joined = agent?.bothJoined();
    vi.advanceTimersByTime(60_000);
    expect(await joined).toBe(false);
    expect(w.registry.pending(s.id)).toBeUndefined();
    expect(w.registry.joinBrowser(s.id, USER, w.port)).toBeUndefined();
    await Promise.resolve();
    expect(w.published[0]?.payload).toMatchObject({
      reason: 'not_joined',
      exitCode: null,
      durationMs: 0,
    });
  });

  it('stops the command when the browser leaves', async () => {
    const w = world();
    const s = session();
    w.registry.add(s, NOW);
    const relay = w.registry.joinBrowser(s.id, USER, w.port);
    w.registry.joinAgent(s.id, node);
    relay?.fromBrowser({ kind: 'stdin', data: new Uint8Array([1]) });
    relay?.browserLeft();
    expect(relay ? await collect(relay.toAgent()) : []).toEqual([
      { kind: 'stdin', data: new Uint8Array([1]) },
      { kind: 'close', kill: true },
    ]);
    await Promise.resolve();
    expect(w.published[0]?.payload).toMatchObject({ reason: 'browser_left' });
  });

  it('names the end from the agent fixed texts, and nothing else', async () => {
    for (const [message, reason] of [
      ['time limit reached', 'time_limit'],
      ['session closed', 'closed'],
      ['session failed', 'failed'],
      ['container /var/lib/x is not running', 'failed'],
    ]) {
      const w = world();
      const s = session();
      w.registry.add(s, NOW);
      w.registry.joinBrowser(s.id, USER, w.port);
      await w.registry.joinAgent(s.id, node)?.fromAgent({ kind: 'error', message });
      await Promise.resolve();
      expect(w.published[0]?.payload).toMatchObject({ reason });
    }
  });

  it('ends a session whose browser floods the agent', async () => {
    const w = world();
    const s = session();
    w.registry.add(s, NOW);
    const relay = w.registry.joinBrowser(s.id, USER, w.port);
    for (let i = 0; i <= MAX_WAITING_FRAMES; i++)
      relay?.fromBrowser({ kind: 'resize', cols: 1, rows: 1 });
    expect(relay?.over).toBe(true);
    await Promise.resolve();
    expect(w.published[0]?.payload).toMatchObject({ reason: 'flooded' });
  });

  it('keeps the session when its audit write fails', async () => {
    const registry = new ExecSessionRegistry(
      { runTenant: () => Promise.reject(new Error('down')) } as unknown as FleetTransaction,
      { publish: () => Promise.resolve() } as unknown as DomainEventBus,
    );
    const s = session();
    registry.add(s, NOW);
    registry.joinAgent(s.id, node)?.agentLeft();
    await Promise.resolve();
    expect(registry.pending(s.id)).toBeUndefined();
  });
});
