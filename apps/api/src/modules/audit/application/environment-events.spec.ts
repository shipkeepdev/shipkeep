import type { AuditRecord } from '../domain/audit-record';

import {
  EnvironmentEvents,
  HEARTBEAT_MS,
  POLL_MS,
  pumpEvents,
  serverSentEvent,
  STREAM_LIFETIME_MS,
} from './environment-events';

const record = (id: string, metadata: Record<string, unknown> = {}): AuditRecord =>
  ({
    id,
    action: 'deployment.advanced',
    targetType: 'deployment',
    targetId: 'd1',
    metadata,
    createdAt: new Date('2026-11-07T12:00:00Z'),
  }) as unknown as AuditRecord;

function pump(
  polls: ((after: string) => readonly AuditRecord[])[],
  options: { abort?: boolean } = {},
) {
  let clock = 0;
  const written: string[] = [];
  const cursors: string[] = [];
  const controller = new AbortController();
  let round = 0;
  const done = pumpEvents({
    after: 'start',
    poll: (after) => {
      cursors.push(after);
      if (round >= polls.length) {
        controller.abort();
        return Promise.resolve([]);
      }
      return Promise.resolve(polls[round++](after));
    },
    write: (chunk) => written.push(chunk),
    signal: controller.signal,
    sleep: (milliseconds) => {
      clock += milliseconds;
      if (options.abort) controller.abort();
      return Promise.resolve();
    },
    now: () => clock,
  });
  return { done, written, cursors, clock: () => clock };
}

describe('serverSentEvent', () => {
  it('reveals identifiers only, never event metadata', () => {
    const event = serverSentEvent(
      record('e1', {
        applicationId: 'app',
        reason: 'postgres://fixture:private@db',
        name: 'SECRET_NAME',
      }),
    );
    expect(event).toBe(
      'id: e1\nevent: change\ndata: {"type":"deployment.advanced","targetType":"deployment","targetId":"d1","applicationId":"app","at":"2026-11-07T12:00:00.000Z"}\n\n',
    );
    expect(event).not.toMatch(/private|SECRET_NAME/);
  });

  it('cannot be broken out of with a newline in a value', () => {
    const event = serverSentEvent({ ...record('e1'), targetId: 'x\n\nevent: forged' });
    expect(event.split('\n\n')).toHaveLength(2);
    expect(event).not.toContain('\nevent: forged');
  });
});

describe('pumpEvents', () => {
  it('writes new events and moves its cursor', async () => {
    const { done, written, cursors } = pump([() => [record('e1'), record('e2')], () => []]);
    await done;
    expect(written.map((chunk) => chunk.split('\n')[0])).toEqual(['id: e1', 'id: e2']);
    expect(cursors).toEqual(['start', 'e2', 'e2']);
  });

  it('ends the stream when a poll fails, such as after revocation', async () => {
    const { done, written } = pump([
      () => {
        throw new Error('forbidden');
      },
      () => [record('e1')],
    ]);
    await done;
    expect(written).toEqual([]);
  });

  it('keeps an idle connection alive', async () => {
    const idle = Array.from({ length: Math.ceil(HEARTBEAT_MS / POLL_MS) }, () => () => []);
    const { done, written } = pump(idle);
    await done;
    expect(written).toEqual([': keep-alive\n\n']);
  });

  it('stops at its lifetime and when the client leaves', async () => {
    const forever = Array.from({ length: STREAM_LIFETIME_MS / POLL_MS + 10 }, () => () => []);
    const lifetime = pump(forever);
    await lifetime.done;
    expect(lifetime.clock()).toBe(STREAM_LIFETIME_MS);
    const left = pump([() => [record('e1')]], { abort: true });
    await left.done;
    expect(left.written).toEqual([]);
  });
});

describe('EnvironmentEvents.run', () => {
  const service = () => new EnvironmentEvents({} as never, {} as never, {} as never);

  it('bounds the streams per account and frees them', async () => {
    const events = service();
    const release: (() => void)[] = [];
    const open = () => events.run('a', () => new Promise<void>((resolve) => release.push(resolve)));
    const streams = Array.from({ length: 8 }, open);
    await expect(open()).rejects.toMatchObject({ status: 429 });
    await expect(events.run('b', () => Promise.resolve())).resolves.toBeUndefined();
    for (const resolve of release) resolve();
    await Promise.all(streams);
    await expect(events.run('a', () => Promise.resolve())).resolves.toBeUndefined();
  });

  it('aborts open streams at shutdown', async () => {
    const events = service();
    let aborted = false;
    const stream = events.run(
      'a',
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        }),
    );
    events.onApplicationShutdown();
    await stream;
    expect(aborted).toBe(true);
  });
});

describe('EnvironmentEvents.poll', () => {
  const target = { organizationId: 'o', projectId: 'p', environmentId: 'e' };
  const context = { userId: 'u', securityVersion: 1, ip: '203.0.113.9', userAgent: 'test' };

  function service(sessionLive: () => Promise<void>) {
    const calls: string[] = [];
    const accounts = {
      assertSessionLive: async () => {
        calls.push('session');
        await sessionLive();
      },
      run: (_context: unknown, operation: () => Promise<unknown>) => {
        calls.push('account');
        return operation();
      },
    };
    const access = {
      require: () => {
        calls.push('permission');
        return Promise.resolve();
      },
    };
    const reader = {
      afterInEnvironment: () => {
        calls.push('read');
        return Promise.resolve([record('e1')]);
      },
    };
    const events = new EnvironmentEvents(reader as never, accounts as never, access as never);
    return { events, calls };
  }

  it('checks the session, then the account and the permission, before reading', async () => {
    const { events, calls } = service(() => Promise.resolve());
    await expect(events.poll(context, target, 'start')).resolves.toHaveLength(1);
    expect(calls).toEqual(['session', 'account', 'permission', 'read']);
  });

  it('reads nothing once the session that opened the stream is gone', async () => {
    const { events, calls } = service(() => Promise.reject(new Error('signed out')));
    await expect(events.poll(context, target, 'start')).rejects.toThrow('signed out');
    expect(calls).toEqual(['session']);
  });
});
