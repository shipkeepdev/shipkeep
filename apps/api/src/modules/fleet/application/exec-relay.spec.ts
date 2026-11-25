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
    // What the browser typed before it left is not sent: the command is stopped at once.
    expect(relay ? await collect(relay.toAgent()) : []).toEqual([{ kind: 'close', kill: true }]);
    await Promise.resolve();
    expect(w.published[0]?.payload).toMatchObject({ reason: 'browser_left' });
  });

  it('drops the input still waiting when a session is ended, and stops the command (#479)', async () => {
    for (const reason of [
      'access_removed',
      'signed_out',
      'time_limit',
      'failed',
      'browser_left',
      'shutdown',
    ] as const) {
      const w = world();
      const s = session();
      w.registry.add(s, NOW);
      const relay = w.registry.joinBrowser(s.id, USER, w.port);
      w.registry.joinAgent(s.id, node);
      if (!relay) throw new Error('not joined');
      relay.fromBrowser({ kind: 'stdin', data: new TextEncoder().encode('rm -rf /data\n') });
      relay.fromBrowser({ kind: 'resize', cols: 80, rows: 24 });
      relay.end(reason, null);
      // Refused once ended, as before.
      relay.fromBrowser({ kind: 'stdin', data: new Uint8Array([1]) });
      expect(await collect(relay.toAgent()), reason).toEqual([{ kind: 'close', kill: true }]);
      await Promise.resolve();
      expect(w.published, reason).toHaveLength(1);
      expect(w.published[0]?.payload, reason).toMatchObject({ reason });
    }
  });

  it('wakes the agent side waiting for input when the session ends', async () => {
    const w = world();
    const s = session();
    w.registry.add(s, NOW);
    const relay = w.registry.joinBrowser(s.id, USER, w.port);
    w.registry.joinAgent(s.id, node);
    if (!relay) throw new Error('not joined');
    const frames = relay.toAgent();
    const waiting = frames.next();
    relay.end('access_removed', null);
    expect((await waiting).value).toEqual({ kind: 'close', kill: true });
    expect((await frames.next()).done).toBe(true);
  });

  it('sends nothing more once the command exited', async () => {
    const w = world();
    const s = session();
    w.registry.add(s, NOW);
    const relay = w.registry.joinBrowser(s.id, USER, w.port);
    const agent = w.registry.joinAgent(s.id, node);
    if (!relay || !agent) throw new Error('not joined');
    relay.fromBrowser({ kind: 'stdin', data: new Uint8Array([1]) });
    await agent.fromAgent({ kind: 'exit', code: 0 });
    expect(await collect(relay.toAgent())).toEqual([]);
  });

  it('names the end from the agent fixed texts, and nothing else', async () => {
    for (const [message, reason] of [
      ['time limit reached', 'time_limit'],
      ['session closed', 'closed'],
      ['session failed', 'failed'],
      ['container /var/lib/x is not running', 'failed'],
      // Names of Object.prototype are no texts of the agent.
      ['constructor', 'failed'],
      ['__proto__', 'failed'],
      ['toString', 'failed'],
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

  it('ends the session even when its audit write fails', async () => {
    const registry = new ExecSessionRegistry(
      { runTenant: () => Promise.reject(new Error('down')) } as unknown as FleetTransaction,
      { publish: () => Promise.resolve() } as unknown as DomainEventBus,
    );
    const s = session();
    registry.add(s, NOW);
    registry.joinAgent(s.id, node)?.agentLeft();
    // The rejected write is caught: flushed here, it raises nothing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.pending(s.id)).toBeUndefined();
  });
});

describe('the control plane side of the time limit', () => {
  it('ends a session the agent did not end, after a grace', () => {
    vi.useFakeTimers();
    try {
      const w = world();
      const s = session();
      w.registry.add(s, NOW);
      w.registry.joinBrowser(s.id, USER, w.port);
      w.registry.joinAgent(s.id, node);
      vi.advanceTimersByTime(s.endsAt.getTime() - NOW.getTime() + 29_000);
      expect(w.registry.pending(s.id)).toBeDefined();
      vi.advanceTimersByTime(2_000);
      expect(w.registry.pending(s.id)).toBeUndefined();
      expect(w.closed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the exit it received when the time limit falls during its delivery', async () => {
    vi.useFakeTimers();
    try {
      const w = world();
      const s = session();
      w.registry.add(s, NOW);
      let delivered: () => void = () => undefined;
      const slow = {
        send: (frame: AgentFrame) => {
          w.received.push(frame);
          return frame.kind === 'exit'
            ? new Promise<void>((resolve) => (delivered = resolve))
            : Promise.resolve();
        },
        close: () => undefined,
      };
      const relay = w.registry.joinBrowser(s.id, USER, slow);
      w.registry.joinAgent(s.id, node);
      vi.advanceTimersByTime(s.endsAt.getTime() - NOW.getTime() + 29_000);
      const exit = relay?.fromAgent({ kind: 'exit', code: 4 });
      // The limit passes while the browser still receives the exit.
      vi.advanceTimersByTime(2_000);
      delivered();
      await exit;
      await vi.runAllTimersAsync();
      expect(w.published[0]).toMatchObject({ payload: { reason: 'exited', exitCode: 4 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts the sessions being opened, so concurrent opens cannot pass the caps', () => {
    const w = world();
    const release = w.registry.reserve({ userId: USER, organizationId: ORG });
    expect(w.registry.count({ userId: USER })).toBe(1);
    release();
    release();
    expect(w.registry.count({ userId: USER })).toBe(0);
  });
});
