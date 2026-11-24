import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { HttpAdapterHost } from '@nestjs/core';
import type { DomainEvent } from '@shipkeep/domain';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type { AppConfig } from '../../../platform/config/app-config';
import type { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { type AgentFrame, ExecSessionRegistry } from '../../fleet/application/exec-relay';
import type { FleetTransaction } from '../../fleet/application/ports';
import type { SessionCommands } from '../../identity/application/session-commands';
import type { TenantAccess } from '../../organizations/application/tenant-access';

import { browserFrame, encode, ExecSocket } from './exec-socket';

const ORG = '019d0000-0000-7000-8000-00000000000a';
const USER = '019d0000-0000-7000-8000-0000000000f1';
const OTHER = '019d0000-0000-7000-8000-0000000000f2';
const NODE = '019d0000-0000-7000-8000-0000000000e1';
const SESSION = '019d0000-0000-7000-8000-0000000000d1';
const PUBLIC = 'https://shipkeep.example.com';
const COOKIE = `__Host-shipkeep_session=${'a'.repeat(43)}`;

const servers: Server[] = [];
afterEach(async () => {
  const running = servers.splice(0);
  await Promise.all(
    running.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function world(options: { user?: string; denied?: boolean; signedOut?: boolean } = {}) {
  const published: DomainEvent[] = [];
  const registry = new ExecSessionRegistry(
    {
      runTenant: (_org: string, work: () => Promise<unknown>) => work(),
    } as unknown as FleetTransaction,
    {
      publish: (batch: DomainEvent[]) => (published.push(...batch), Promise.resolve()),
    } as unknown as DomainEventBus,
  );
  const now = new Date();
  registry.add(
    {
      id: SESSION,
      organizationId: ORG,
      projectId: '019d0000-0000-7000-8000-00000000000b',
      environmentId: '019d0000-0000-7000-8000-00000000000c',
      applicationId: '019d0000-0000-7000-8000-0000000000a1',
      userId: USER,
      nodeId: NODE,
      container: 'sk-web-r1-0',
      tty: true,
      attachBy: new Date(now.getTime() + 60_000),
      endsAt: new Date(now.getTime() + 120_000),
    },
    now,
  );
  const socket = new ExecSocket(
    {} as HttpAdapterHost,
    { get: () => PUBLIC } as unknown as AppConfig,
    {
      authenticate: () =>
        options.signedOut
          ? Promise.reject(new Error('signed out'))
          : Promise.resolve({ user: { id: options.user ?? USER } }),
      assertLive: () => Promise.resolve(),
    } as unknown as SessionCommands,
    {
      require: () => (options.denied ? Promise.reject(new Error('denied')) : Promise.resolve()),
    } as unknown as TenantAccess,
    registry,
  );
  const server = createServer();
  servers.push(server);
  socket.listen(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    registry,
    published,
    url: `ws://127.0.0.1:${String(port)}/api/v1/exec/${SESSION}`,
    port,
  };
}

function connect(url: string, headers: Record<string, string>): Promise<WebSocket | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => {
      resolve(ws);
    });
    ws.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
    });
    ws.once('error', () => {
      resolve(0);
    });
  });
}

const allowed = { Origin: PUBLIC, Cookie: COOKIE };

describe('the browser side of an exec session', () => {
  it('refuses another origin, no sign-in, another person, no permission and other paths', async () => {
    const w = await world();
    expect(await connect(w.url, { Origin: 'https://evil.example', Cookie: COOKIE })).toBe(401);
    expect(await connect(w.url, { Origin: PUBLIC })).toBe(401);
    expect(
      await connect(w.url.replace(SESSION, '019d0000-0000-7000-8000-000000000000'), allowed),
    ).toBe(404);
    expect(await connect(w.url.replace('/exec/', '/exec/../'), allowed)).toBe(404);
    expect(await connect(`${w.url}?x=1`, allowed)).toBe(404);
    const other = await world({ user: OTHER });
    expect(await connect(other.url, allowed)).toBe(404);
    const denied = await world({ denied: true });
    expect(await connect(denied.url, allowed)).toBe(404);
    const signedOut = await world({ signedOut: true });
    expect(await connect(signedOut.url, allowed)).toBe(401);
    // None of them joined: the session still waits for its person.
    expect(w.registry.pending(SESSION)).toBeDefined();
  });

  it('relays output to the browser and its input to the agent, then closes at the exit', async () => {
    const w = await world();
    const ws = await connect(w.url, allowed);
    if (typeof ws === 'number') throw new Error(`refused: ${String(ws)}`);
    const relay = w.registry.joinAgent(SESSION, { organizationId: ORG, nodeId: NODE });
    expect(await relay?.bothJoined()).toBe(true);
    const messages: { data: Buffer | string; binary: boolean }[] = [];
    const closed = new Promise<number>((resolve) =>
      ws.once('close', (code) => {
        resolve(code);
      }),
    );
    ws.on('message', (data: Buffer, binary) =>
      messages.push({ data: binary ? data : data.toString(), binary }),
    );
    ws.send(Buffer.from('ls\n'));
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    const toAgent = relay?.toAgent();
    expect((await toAgent?.next())?.value).toEqual({
      kind: 'stdin',
      data: new Uint8Array(Buffer.from('ls\n')),
    });
    expect((await toAgent?.next())?.value).toEqual({ kind: 'resize', cols: 100, rows: 30 });
    await relay?.fromAgent({ kind: 'stdout', data: new TextEncoder().encode('a.txt\n') });
    await relay?.fromAgent({ kind: 'exit', code: 0 });
    expect(await closed).toBe(1000);
    expect(messages).toEqual([
      { data: Buffer.from([1, ...Buffer.from('a.txt\n')]), binary: true },
      { data: '{"type":"exit","code":0}', binary: false },
    ]);
    expect(w.published.at(-1)?.payload).toMatchObject({ reason: 'exited', exitCode: 0 });
  });

  it('joins only once, and ends the session when the browser leaves', async () => {
    const w = await world();
    const first = await connect(w.url, allowed);
    if (typeof first === 'number') throw new Error('refused');
    const second = await connect(w.url, allowed);
    // The second connection is upgraded, then closed: the session was taken.
    if (typeof second !== 'number')
      expect(await new Promise((resolve) => second.once('close', resolve))).toBe(4404);
    const relay = w.registry.joinAgent(SESSION, { organizationId: ORG, nodeId: NODE });
    first.close();
    const frames = [];
    if (relay) for await (const frame of relay.toAgent()) frames.push(frame);
    expect(frames).toEqual([{ kind: 'close', kill: true }]);
    await Promise.resolve();
    expect(w.published.at(-1)?.payload).toMatchObject({ reason: 'browser_left' });
  });
});

describe('the browser messages', () => {
  it('takes binary input, bounded resizes and close, and ignores anything else', () => {
    expect(browserFrame(Buffer.from('x'), true)).toEqual({
      kind: 'stdin',
      data: new Uint8Array([120]),
    });
    expect(browserFrame(Buffer.from('{"type":"resize","cols":80,"rows":24}'), false)).toEqual({
      kind: 'resize',
      cols: 80,
      rows: 24,
    });
    expect(browserFrame(Buffer.from('{"type":"close","kill":true}'), false)).toEqual({
      kind: 'close',
      kill: true,
    });
    for (const text of [
      'not json',
      'null',
      '[]',
      '{"type":"resize","cols":0,"rows":24}',
      '{"type":"resize","cols":1001,"rows":24}',
      '{"type":"resize","cols":1.5,"rows":24}',
      '{"type":"resize","cols":"80","rows":24}',
      '{"type":"close","kill":"yes"}',
      '{"type":"stdin","data":"rm -rf /"}',
      '{"__proto__":{"type":"close"}}',
    ])
      expect(browserFrame(Buffer.from(text), false), text).toBeUndefined();
  });

  it('sends output with its stream, and an error only as the reason it maps to', () => {
    const frame: AgentFrame = { kind: 'stderr', data: new Uint8Array([104, 105]) };
    expect(encode(frame)).toEqual(Buffer.from([2, 104, 105]));
    expect(encode({ kind: 'error', message: 'time limit reached' })).toBe(
      '{"type":"end","reason":"time_limit"}',
    );
    expect(encode({ kind: 'error', message: '<script>alert(1)</script>' })).toBe(
      '{"type":"end","reason":"failed"}',
    );
  });
});
