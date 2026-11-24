import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { type ExecStreamRequest, ExecStreamRequestSchema } from '@shipkeep/proto-ts';
import { describe, expect, it } from 'vitest';

import type { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { type AgentFrame, ExecSessionRegistry } from '../application/exec-relay';
import type { FleetTransaction } from '../application/ports';

import { relayExecStream } from './exec-stream';

const ORG = '019d0000-0000-7000-8000-00000000000a';
const NODE = '019d0000-0000-7000-8000-0000000000e1';
const USER = '019d0000-0000-7000-8000-0000000000f1';
const SESSION = '019d0000-0000-7000-8000-0000000000d1';
const NOW = new Date();
const node = { organizationId: ORG, nodeId: NODE, serial: '01' };

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
    expect(await codeOf(relayExecStream(r, frames(stdout('x')), node))).toBe(Code.InvalidArgument);
    expect(await codeOf(relayExecStream(r, frames(), node))).toBe(Code.InvalidArgument);
    const unknown = create(ExecStreamRequestSchema, {
      frame: { case: 'open', value: { sessionId: '019d0000-0000-7000-8000-000000000000' } },
    });
    expect(await codeOf(relayExecStream(r, frames(unknown), node))).toBe(Code.NotFound);
    // Another node of the organization cannot take the session.
    expect(
      await codeOf(
        relayExecStream(r, frames(open), {
          ...node,
          nodeId: '019d0000-0000-7000-8000-0000000000e9',
        }),
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
    const responses = relayExecStream(r, frames(open, stdout('uid=0\n'), exit(0)), node);
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
    const responses = relayExecStream(r, frames(open, open), node);
    const out: { case: string | undefined; kill: boolean | undefined }[] = [];
    for await (const response of responses)
      out.push({
        case: response.frame.case,
        kill: response.frame.case === 'close' ? response.frame.value.kill : undefined,
      });
    expect(out).toEqual([{ case: 'close', kill: true }]);
  });
});
