import { createServer, type Server } from 'node:http';
import { type AddressInfo, createConnection, type Socket } from 'node:net';
import type { AuditEventReader } from '../../audit/application/audit-event-reader';

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

import { controlFrame } from './exec-socket.dto';
import { browserFrame, encode, ExecSocket } from './exec-socket';

const ORG = '019d0000-0000-7000-8000-00000000000a';
const USER = '019d0000-0000-7000-8000-0000000000f1';
const OTHER = '019d0000-0000-7000-8000-0000000000f2';
const NODE = '019d0000-0000-7000-8000-0000000000e1';
const SESSION = '019d0000-0000-7000-8000-0000000000d1';
const SECOND = '019d0000-0000-7000-8000-0000000000d2';
const PUBLIC = 'https://shipkeep.example.com';
// The sample nonce of RFC 6455, section 1.3: a handshake value, not a credential.
const SAMPLE_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='; // gitleaks:allow (RFC 6455 sample nonce)
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

async function world(
  options: {
    user?: string;
    denied?: boolean;
    signedOut?: boolean;
    slow?: Promise<void>;
    slowAccess?: Promise<void>;
    trust?: string;
  } = {},
) {
  const published: DomainEvent[] = [];
  const registry = new ExecSessionRegistry(
    {
      runTenant: (_org: string, work: () => Promise<unknown>) => work(),
    } as unknown as FleetTransaction,
    {
      publish: (batch: DomainEvent[]) => (published.push(...batch), Promise.resolve()),
    } as unknown as DomainEventBus,
    { page: () => Promise.resolve([]) } as unknown as AuditEventReader,
  );
  const now = new Date();
  for (const id of [SESSION, SECOND])
    registry.add(
      {
        id,
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
    {
      get: (key: string) => (key === 'TRUST_PROXY' ? (options.trust ?? 'none') : PUBLIC),
    } as unknown as AppConfig,
    {
      authenticate: async () => {
        await options.slow;
        return options.signedOut
          ? Promise.reject(new Error('signed out'))
          : { user: { id: options.user ?? USER } };
      },
      assertLive: () => Promise.resolve(),
    } as unknown as SessionCommands,
    {
      require: async () => {
        await options.slowAccess;
        if (options.denied) throw new Error('denied');
      },
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
    socket,
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
    // The second connection is refused like an unknown session: it was taken.
    expect(await connect(w.url, allowed)).toBe(404);
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

  it('refuses, without throwing, a control message carrying anything it does not expect', () => {
    const depth = 3000;
    const nested = `${'{"a":'.repeat(depth)}{}${'}'.repeat(depth)}`;
    for (const text of [
      // Under the 64 KiB limit, deep enough to overflow a recursive transformation.
      `{"type":"resize","cols":80,"rows":24,"x":${nested}}`,
      `{"type":"close","kill":true,"x":${nested}}`,
      `${'['.repeat(30_000)}${']'.repeat(30_000)}`,
      '{"type":"resize","cols":80,"rows":24,"extra":1}',
      '{"type":"close","kill":true,"constructor":{"prototype":{"x":1}}}',
    ]) {
      expect(text.length).toBeLessThan(64 * 1024);
      // The shape check itself, not a catch around it, keeps a transformation from overflowing.
      expect(() => controlFrame(JSON.parse(text))).not.toThrow();
      expect(controlFrame(JSON.parse(text))).toBeUndefined();
      expect(() => browserFrame(Buffer.from(text), false)).not.toThrow();
      expect(browserFrame(Buffer.from(text), false), text.slice(0, 60)).toBeUndefined();
    }
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

describe('the WebSocket handshake', () => {
  it('survives a client that resets its connection while its sign-in is checked', async () => {
    let release = (): void => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const w = await world({ slow });
    const raw = connectRaw(w.port);
    raw.write(
      `GET /api/v1/exec/${SESSION} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${SAMPLE_KEY}\r\nOrigin: ${PUBLIC}\r\nCookie: ${COOKIE}\r\n\r\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    raw.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Still serving: the process did not crash, and the session still waits for its person.
    expect(w.registry.pending(SESSION)).toBeDefined();
    const ws = await connect(w.url, allowed);
    if (typeof ws === 'number') throw new Error(`refused: ${String(ws)}`);
    ws.terminate();
  });

  it('keeps serving a session, and the others, after a malformed control message', async () => {
    const w = await world();
    const ws = await connect(w.url, allowed);
    if (typeof ws === 'number') throw new Error(`refused: ${String(ws)}`);
    const relay = w.registry.joinAgent(SESSION, { organizationId: ORG, nodeId: NODE });
    const toAgent = relay?.toAgent();
    const depth = 3000;
    ws.send(
      `{"type":"resize","cols":80,"rows":24,"x":${'{"a":'.repeat(depth)}{}${'}'.repeat(depth)}}`,
    );
    ws.send('{"type":"resize","cols":100,"rows":30}');
    // The malformed message was dropped; the next one went through, and the server still answers.
    expect((await toAgent?.next())?.value).toEqual({ kind: 'resize', cols: 100, rows: 30 });
    const second = await connect(w.url.replace(SESSION, SECOND), allowed);
    expect(typeof second).not.toBe('number');
    if (typeof second !== 'number') second.terminate();
    ws.terminate();
  });

  it('ends only its own session, as failed, when a message cannot be read', async () => {
    const w = await world();
    const join = w.registry.joinBrowser.bind(w.registry);
    w.registry.joinBrowser = (...args: Parameters<typeof join>) => {
      const relay = join(...args);
      if (relay && args[0] === SESSION)
        relay.fromBrowser = () => {
          throw new Error('unreadable');
        };
      return relay;
    };
    const ws = await connect(w.url, allowed);
    if (typeof ws === 'number') throw new Error(`refused: ${String(ws)}`);
    const messages: string[] = [];
    ws.on('message', (data: Buffer, binary) => {
      if (!binary) messages.push(data.toString());
    });
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    ws.send('{"type":"resize","cols":100,"rows":30}');
    await closed;
    expect(messages).toEqual(['{"type":"end","reason":"failed"}']);
    const second = await connect(w.url.replace(SESSION, SECOND), allowed);
    expect(typeof second).not.toBe('number');
    if (typeof second !== 'number') second.terminate();
  });

  it('limits failed joins from one network', async () => {
    const w = await world({ signedOut: true });
    for (let i = 0; i < 20; i++) expect(await connect(w.url, allowed)).toBe(401);
    expect(await connect(w.url, allowed)).toBe(429);
  });

  it('counts failed joins by the client a trusted proxy forwarded, not by the proxy', async () => {
    const w = await world({ signedOut: true, trust: 'loopback' });
    const from = (client: string) => ({ ...allowed, 'X-Forwarded-For': client });
    for (let i = 0; i < 20; i++) expect(await connect(w.url, from('203.0.113.5'))).toBe(401);
    expect(await connect(w.url, from('203.0.113.5'))).toBe(429);
    // Another browser behind the same proxy is not refused for it.
    expect(await connect(w.url, from('203.0.113.6'))).toBe(401);
  });

  it('refuses over HTTP a join that another one overtook while its access was checked', async () => {
    let release = (): void => undefined;
    const slowAccess = new Promise<void>((resolve) => (release = resolve));
    const w = await world({ slowAccess });
    const first = connect(w.url, allowed);
    const second = connect(w.url, allowed);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const answers = await Promise.all([first, second]);
    expect(answers.filter((answer) => typeof answer !== 'number')).toHaveLength(1);
    expect(answers.filter((answer) => answer === 404)).toHaveLength(1);
    for (const answer of answers) if (typeof answer !== 'number') answer.terminate();
  });

  it('ends every session at shutdown, joined or not, and waits for its audit', async () => {
    const w = await world();
    const ws = await connect(w.url, allowed);
    if (typeof ws === 'number') throw new Error(`refused: ${String(ws)}`);
    const unjoined = await world();
    await Promise.all([w.socket.onModuleDestroy(), unjoined.socket.onModuleDestroy()]);
    expect(w.published.at(-1)).toMatchObject({
      type: 'exec.session.ended',
      payload: { reason: 'shutdown' },
    });
    expect(unjoined.published.at(-1)).toMatchObject({ payload: { reason: 'shutdown' } });
    expect(w.registry.pending(SESSION)).toBeUndefined();
  });

  it('tells the browser why its session ended', async () => {
    const w = await world();
    const ws = await connect(w.url, allowed);
    if (typeof ws === 'number') throw new Error('refused');
    const messages: string[] = [];
    ws.on('message', (data: Buffer, binary) => {
      if (!binary) messages.push(data.toString());
    });
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    w.registry.joinAgent(SESSION, { organizationId: ORG, nodeId: NODE })?.agentLeft();
    expect(await closed).toBe(1000);
    expect(messages).toEqual(['{"type":"end","reason":"agent_left"}']);
  });
});

function connectRaw(port: number): Socket {
  return createConnection({ host: '127.0.0.1', port });
}
