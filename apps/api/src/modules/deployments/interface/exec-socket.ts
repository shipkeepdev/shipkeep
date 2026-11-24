import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Secret } from '@shipkeep/domain';
import { type RawData, WebSocket, WebSocketServer } from 'ws';

import { AppConfig } from '../../../platform/config/app-config';
import {
  type AgentFrame,
  type BrowserFrame,
  type BrowserPort,
  ExecSessionRegistry,
  execEndOf,
} from '../../fleet/application/exec-relay';
import { SessionCommands } from '../../identity/application/session-commands';
import { assertOrigin, cookiePolicy, readCredential } from '../../identity/interface/session-http';
import { TenantAccess } from '../../organizations/application/tenant-access';

/** The path that joins a session, under the API prefix (SPEC 3.1). */
const EXEC_PATH =
  /^\/api\/v1\/exec\/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
/** The largest message a browser may send: one stdin frame or one control message. */
export const MAX_BROWSER_MESSAGE = 64 * 1024;
/** How often an open session checks that the person is still signed in. */
const SIGN_IN_CHECK_MS = 60_000;
const TERMINAL_SIDE = 1000;

/**
 * The browser's side of an exec session: a WebSocket on `/api/v1/exec/{id}`, joined once by the
 * person who opened the session, with their sign-in cookie, from the interface's own origin, while
 * they still hold `container.exec` on its environment. Every refusal is the same 404 once the
 * origin and the sign-in are checked, whatever the reason.
 *
 * To the browser: binary messages of output, stream 1 (stdout) or 2 (stderr) in their first byte,
 * then text `{"type":"exit","code":n}` or `{"type":"end","reason":…}`. From the browser: binary
 * messages are stdin; text `{"type":"resize","cols":n,"rows":n}` or `{"type":"close","kill":b}`.
 */
@Injectable()
export class ExecSocket implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ExecSocket.name);
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BROWSER_MESSAGE,
  });

  constructor(
    private readonly http: HttpAdapterHost,
    private readonly config: AppConfig,
    private readonly sessions: SessionCommands,
    private readonly tenants: TenantAccess,
    private readonly registry: ExecSessionRegistry,
  ) {}

  onApplicationBootstrap(): void {
    // A module compiled without an HTTP application, as in tests, has no adapter.
    const adapter = this.http.httpAdapter as HttpAdapterHost['httpAdapter'] | undefined;
    const server = adapter?.getHttpServer() as Server | undefined;
    if (server) this.listen(server);
  }

  onModuleDestroy(): void {
    for (const client of this.sockets.clients) client.terminate();
    this.sockets.close();
  }

  /** Takes the server's WebSocket upgrades. */
  listen(server: Server): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.upgrade(request, socket, head).catch(() => {
        refuse(socket, 500);
      });
    });
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const id = EXEC_PATH.exec(request.url ?? '')?.at(1);
    if (!id) {
      refuse(socket, 404);
      return;
    }
    const publicUrl = this.config.get('API_PUBLIC_URL');
    let token: Secret;
    let userId: string;
    try {
      // A cookie goes with every request to this origin: only the interface's own pages join.
      assertOrigin(request, publicUrl);
      token = readCredential(request.headers.cookie, cookiePolicy(publicUrl).name);
      userId = (await this.sessions.authenticate(token)).user.id;
    } catch {
      refuse(socket, 401);
      return;
    }
    const session = this.registry.pending(id);
    if (!session || session.userId !== userId) {
      refuse(socket, 404);
      return;
    }
    try {
      await this.tenants.require(userId, 'container.exec', {
        organizationId: session.organizationId,
        projectId: session.projectId,
        environmentId: session.environmentId,
      });
    } catch {
      refuse(socket, 404);
      return;
    }
    this.sockets.handleUpgrade(request, socket, head, (ws) => {
      this.attach(ws, id, userId, token);
    });
  }

  private attach(ws: WebSocket, id: string, userId: string, token: Secret): void {
    const port: BrowserPort = {
      send: (frame) => send(ws, frame),
      close: () => {
        ws.close(1000);
      },
    };
    const relay = this.registry.joinBrowser(id, userId, port);
    if (!relay) {
      ws.close(4404);
      return;
    }
    ws.on('message', (data, binary) => {
      const frame = browserFrame(data, binary);
      if (frame) relay.fromBrowser(frame);
    });
    // Signing out, or a password change, ends the session too.
    const check = setInterval(() => {
      this.sessions.assertLive(userId, token).catch(() => {
        relay.end('signed_out', null);
      });
    }, SIGN_IN_CHECK_MS);
    check.unref();
    ws.on('close', () => {
      clearInterval(check);
      relay.browserLeft();
    });
    ws.on('error', () => {
      this.logger.warn(`exec session ${id}: browser connection failed`);
    });
  }
}

function refuse(socket: Duplex, status: 401 | 404 | 500): void {
  const text = { 401: 'Unauthorized', 404: 'Not Found', 500: 'Internal Server Error' }[status];
  socket.end(
    `HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

/** Writes one frame; resolves once it is written, or at once on a closed connection. */
export function send(ws: Pick<WebSocket, 'readyState' | 'send'>, frame: AgentFrame): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return Promise.resolve();
  const data = encode(frame);
  return new Promise((resolve) => {
    ws.send(data, () => {
      resolve();
    });
  });
}

/** The browser's form of an agent frame; an error carries only the reason it maps to. */
export function encode(frame: AgentFrame): Buffer | string {
  switch (frame.kind) {
    case 'stdout':
    case 'stderr':
      return Buffer.concat([Buffer.from([frame.kind === 'stdout' ? 1 : 2]), frame.data]);
    case 'exit':
      return JSON.stringify({ type: 'exit', code: frame.code });
    case 'error':
      return JSON.stringify({ type: 'end', reason: execEndOf(frame.message) });
  }
}

/** A browser message as a frame, or undefined when it is none: it is then ignored. */
export function browserFrame(data: RawData, binary: boolean): BrowserFrame | undefined {
  const bytes = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : data;
  if (binary) return { kind: 'stdin', data: new Uint8Array(bytes) };
  let message: unknown;
  try {
    message = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!message || typeof message !== 'object') return undefined;
  const value = message as Record<string, unknown>;
  if (value['type'] === 'resize') {
    const { cols, rows } = value;
    if (side(cols) && side(rows)) return { kind: 'resize', cols, rows };
    return undefined;
  }
  if (value['type'] === 'close' && typeof value['kill'] === 'boolean')
    return { kind: 'close', kill: value['kill'] };
  return undefined;
}

function side(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= TERMINAL_SIDE;
}
