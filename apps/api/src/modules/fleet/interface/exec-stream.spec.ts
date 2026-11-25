import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { type ExecStreamRequest, ExecStreamRequestSchema } from '@shipkeep/proto-ts';
import { describe, expect, it, vi } from 'vitest';

import type { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { type AgentFrame, ExecSessionRegistry } from '../application/exec-relay';
import type { FleetTransaction } from '../application/ports';
import { NodeAuthenticationError } from '../domain/node-identity';

import { EXEC_OPEN_MS, relayExecStream } from './exec-stream';

const ORG = '019d0000-0000-7000-8000-00000000000a';
const NODE = '019d0000-0000-7000-8000-0000000000e1';
const USER = '019d0000-0000-7000-8000-0000000000f1';
const SESSION = '019d0000-0000-7000-8000-0000000000d1';
const NOW = new Date();
const node = { organizationId: ORG, nodeId: NODE, serial: '01' };
const valid = () => Promise.resolve();

function registry(): ExecSessionRegistry {
  const value = new ExecSessionRegistry(
    {
      runTenant: (_org: string, work: () => Promise<unknown>) => work(),
    } as unknown as FleetTransaction,
    { publish: () => Promise.resolve() } as unknown as DomainEventBus,
  );
  value.add(
    {
      id: SESSION,
      organizationId: ORG,
      projectId: '019d0000-0000-7000-8000-00000000000b',
      environmentId: '019d0000-0000-7000-8000-00000000000c',
      applicationId: '019d0000-0000-7000-8000-0000000000a1',
      userId: USER,
      nodeId: NODE,
      container: 'sk-web-r1-0',
      tty: false,
      attachBy: new Date(NOW.getTime() + 60_000),
      endsAt: new Date(NOW.getTime() + 120_000),
    },
    NOW,
  );
  return value;
}

const open = create(ExecStreamRequestSchema, {
  frame: { case: 'open', value: { sessionId: SESSION } },
});
const stdout = (text: string) =>
  create(ExecStreamRequestSchema, {
    frame: { case: 'stdout', value: new TextEncoder().encode(text) },
  });
const exit = (code: number) =>
  create(ExecStreamRequestSchema, { frame: { case: 'exit', value: { exitCode: code } } });

async function* frames(...items: ExecStreamRequest[]): AsyncGenerator<ExecStreamRequest> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}

async function codeOf(stream: AsyncGenerator): Promise<Code | undefined> {
  try {
    await stream.next();
  } catch (error) {
    return error instanceof ConnectError ? error.code : undefined;
  }
  return undefined;
}

describe('the gateway side of an exec session', () => {
  it('refuses a stream that does not open a session first, or opens an unknown one', async () => {
    const r = registry();
    expect(await codeOf(relayExecStream(r, frames(stdout('x')), node, valid))).toBe(
      Code.InvalidArgument,
    );
    expect(await codeOf(relayExecStream(r, frames(), node, valid))).toBe(Code.InvalidArgument);
    const unknown = create(ExecStreamRequestSchema, {
      frame: { case: 'open', value: { sessionId: '019d0000-0000-7000-8000-000000000000' } },
    });
    expect(await codeOf(relayExecStream(r, frames(unknown), node, valid))).toBe(Code.NotFound);
    // Another node of the organization cannot take the session.
    expect(
      await codeOf(
        relayExecStream(
          r,
          frames(open),
          { ...node, nodeId: '019d0000-0000-7000-8000-0000000000e9' },
          valid,
        ),
      ),
    ).toBe(Code.NotFound);
  });

  it('carries output to the browser, and the browser input to the agent, until the exit', async () => {
    const r = registry();
    const received: AgentFrame[] = [];
    const relay = r.joinBrowser(SESSION, USER, {
      send: (frame) => (received.push(frame), Promise.resolve()),
      close: () => undefined,
    });
    relay?.fromBrowser({ kind: 'stdin', data: new TextEncoder().encode('id\n') });
    const responses = relayExecStream(r, frames(open, stdout('uid=0\n'), exit(0)), node, valid);
    const first = await responses.next();
    if (first.done) throw new Error('the stream ended first');
    expect(first.value.frame).toEqual({
      case: 'stdin',
      value: new TextEncoder().encode('id\n'),
    });
    // The exit ends the session: the stream to the agent ends with it.
    expect((await responses.next()).done).toBe(true);
    expect(received).toEqual([
      { kind: 'stdout', data: new TextEncoder().encode('uid=0\n') },
      { kind: 'exit', code: 0 },
    ]);
    expect(r.pending(SESSION)).toBeUndefined();
  });

  it('ends the session, and stops the command, on a second open', async () => {
    const r = registry();
    r.joinBrowser(SESSION, USER, { send: () => Promise.resolve(), close: () => undefined });
    const responses = relayExecStream(r, frames(open, open), node, valid);
    const out: { case: string | undefined; kill: boolean | undefined }[] = [];
    for await (const response of responses)
      out.push({
        case: response.frame.case,
        kill: response.frame.case === 'close' ? response.frame.value.kill : undefined,
      });
    expect(out).toEqual([{ case: 'close', kill: true }]);
  });
});

describe('a session whose node loses its credential', () => {
  it('ends, and stops the command', async () => {
    vi.useFakeTimers();
    try {
      const r = registry();
      r.joinBrowser(SESSION, USER, { send: () => Promise.resolve(), close: () => undefined });
      let revoked = false;
      async function* silent(): AsyncGenerator<ExecStreamRequest> {
        yield open;
        // The agent stays silent: only the check ends the session.
        await new Promise(() => undefined);
      }
      const responses = relayExecStream(r, silent(), node, () =>
        revoked ? Promise.reject(new Error('revoked')) : Promise.resolve(),
      );
      const first = responses.next();
      // Joined first, with a valid credential; revoked during the session.
      await vi.advanceTimersByTimeAsync(0);
      expect(r.joinAgent(SESSION, node)).toBeUndefined();
      revoked = true;
      await vi.advanceTimersByTimeAsync(10_000);
      const frame = await first;
      expect(frame.done ? undefined : frame.value.frame.case).toBe('close');
      expect(r.pending(SESSION)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the opening of an exec stream (#478)', () => {
  async function* silent(): AsyncGenerator<ExecStreamRequest> {
    // An agent that opens its stream and never names a session.
    await new Promise(() => undefined);
    yield open;
  }

  it('ends a stream that names no session in time, and leaves the session to its agent', async () => {
    vi.useFakeTimers();
    try {
      const r = registry();
      const checks = vi.fn(valid);
      const code = codeOf(relayExecStream(r, silent(), node, checks));
      await vi.advanceTimersByTimeAsync(EXEC_OPEN_MS);
      expect(await code).toBe(Code.DeadlineExceeded);
      expect(checks).not.toHaveBeenCalled();
      // Not joined: a valid agent still can.
      expect(r.joinAgent(SESSION, node)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a stream whose transport is cancelled while it opens', async () => {
    const r = registry();
    const cancelled = new AbortController();
    const code = codeOf(relayExecStream(r, silent(), node, valid, cancelled.signal));
    cancelled.abort();
    expect(await code).toBe(Code.Canceled);
    const already = new AbortController();
    already.abort();
    expect(await codeOf(relayExecStream(r, silent(), node, valid, already.signal))).toBe(
      Code.Canceled,
    );
  });

  it('checks the node again before it joins, and refuses one revoked meanwhile', async () => {
    const r = registry();
    const revoked = () => Promise.reject(new NodeAuthenticationError());
    expect(await codeOf(relayExecStream(r, frames(open), node, revoked))).toBe(
      Code.Unauthenticated,
    );
    // A store that cannot tell is no refusal of the node.
    const down = () => Promise.reject(new Error('connection refused'));
    expect(await codeOf(relayExecStream(r, frames(open), node, down))).toBe(Code.Unavailable);
    // A session that is not this node's is refused before any check.
    const unasked = vi.fn(valid);
    const other = { ...node, nodeId: '019d0000-0000-7000-8000-0000000000e2' };
    expect(await codeOf(relayExecStream(r, frames(open), other, unasked))).toBe(Code.NotFound);
    expect(unasked).not.toHaveBeenCalled();
    // Not joined: the session still waits for a valid agent.
    const checks = vi.fn(valid);
    r.joinBrowser(SESSION, USER, { send: () => Promise.resolve(), close: () => undefined });
    const responses = relayExecStream(r, frames(open, exit(0)), node, checks);
    const out: string[] = [];
    for await (const frame of responses) out.push(frame.frame.case ?? '');
    expect(checks).toHaveBeenCalledTimes(1);
    expect(out).toEqual([]);
  });

  it('bounds the check too, and joins nothing for a stream cancelled during it', async () => {
    vi.useFakeTimers();
    try {
      const r = registry();
      const stalled = () => new Promise(() => undefined);
      const code = codeOf(relayExecStream(r, frames(open), node, stalled));
      await vi.advanceTimersByTimeAsync(EXEC_OPEN_MS);
      expect(await code).toBe(Code.DeadlineExceeded);
      let pass: () => void = () => undefined;
      const slow = () => new Promise<void>((resolve) => (pass = resolve));
      const cancelled = new AbortController();
      const later = codeOf(relayExecStream(r, frames(open), node, slow, cancelled.signal));
      await vi.advanceTimersByTimeAsync(0);
      cancelled.abort();
      pass();
      expect(await later).toBe(Code.Canceled);
      expect(r.joinAgent(SESSION, node)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
