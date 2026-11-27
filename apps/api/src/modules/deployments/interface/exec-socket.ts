import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { isDomainError, type Secret } from '@shipkeep/domain';
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
import { AuthenticationError } from '../../identity/domain/identity-policy';
import {
  assertOrigin,
  cookiePolicy,
  readCredential,
  upgradeClientIp,
} from '../../identity/interface/session-http';
import { TenantAccess } from '../../organizations/application/tenant-access';

import { controlFrame } from './exec-socket.dto';

/** The path that joins a session, under the API prefix (SPEC 3.1). */
const EXEC_PATH =
  /^\/api\/v1\/exec\/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
/** The largest message a browser may send: one stdin frame or one control message. */
export const MAX_BROWSER_MESSAGE = 64 * 1024;
/** How often an open session checks that the person is still signed in and allowed. */
const ACCESS_CHECK_MS = 60_000;
/** How often the browser is pinged; one that misses a pong in that time is gone. */
const KEEPALIVE_MS = 30_000;
/**
 * Refused joins one network may make per minute, joins still being checked included: each costs a
 * sign-in lookup, which writes the session's activity (#546). Past it, joins answer 429 before
 * the sign-in is read, until the minute is over.
 */
const FAILED_JOINS_PER_MINUTE = 20;

type Scope = { organizationId: string; projectId: string; environmentId: string };

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
  private readonly failures = new Map<string, { count: number; since: number }>();
  /** Joins being checked, by network: they count against the budget until they end. */
  private readonly checking = new Map<string, number>();
  private server: Server | undefined;
  private readonly onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Until ws takes the socket, a reset from the client must find a listener, or Node throws.
    const drop = (): void => {
      socket.destroy();
    };
    socket.on('error', drop);
    this.upgrade(request, socket, head, drop).catch(() => {
      refuse(socket, 500);
    });
  };

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

  /** Ends the open sessions, and waits for their audit events, before the database closes. */
  async onModuleDestroy(): Promise<void> {
    this.server?.off('upgrade', this.onUpgrade);
    // Every session ends here, those still waiting for their browser included, so that each
    // audit write has started before the wait below takes its snapshot.
    this.registry.endAll('shutdown');
    for (const client of this.sockets.clients) client.terminate();
    this.sockets.close();
    await this.registry.settle(5000);
  }

  /** Takes the server's WebSocket upgrades on the exec path. */
  listen(server: Server): void {
    this.server = server;
    server.on('upgrade', this.onUpgrade);
  }

  private async upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    drop: () => void,
  ): Promise<void> {
    const id = EXEC_PATH.exec(request.url ?? '')?.at(1);
    if (!id) {
      // Another path belongs to another listener, if there is one.
      socket.off('error', drop);
      if (this.server?.listenerCount('upgrade') === 1) refuse(socket, 404);
      return;
    }
    // Behind Caddy every request comes from loopback: the client is the address it forwarded.
    const ip = upgradeClientIp(request, this.config.get('TRUST_PROXY'));
    if (!this.admit(ip)) {
      refuse(socket, 429);
      return;
    }
    try {
      await this.join(request, socket, head, drop, id, ip);
    } finally {
      this.release(ip);
    }
  }

  /**
   * Checks a join the budget admitted. Every refusal counts against the network's budget, after
   * the sign-in too: an unknown, joined or forbidden session answers 404 like the others, and
   * costs the same (#546).
   */
  private async join(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    drop: () => void,
    id: string,
    ip: string,
  ): Promise<void> {
    const refused = (status: 401 | 404): void => {
      this.failed(ip);
      refuse(socket, status);
    };
    const publicUrl = this.config.get('API_PUBLIC_URL');
    let token: Secret;
    let userId: string;
    try {
      // A cookie goes with every request to this origin: only the interface's own pages join.
      assertOrigin(request, publicUrl);
      token = readCredential(request.headers.cookie, cookiePolicy(publicUrl).name);
      userId = (await this.sessions.authenticate(token)).user.id;
    } catch {
      refused(401);
      return;
    }
    const session = this.registry.pending(id);
    // A session already joined is refused like an unknown one.
    if (!session || !this.registry.joinable(id, userId)) {
      refused(404);
      return;
    }
    const scope: Scope = {
      organizationId: session.organizationId,
      projectId: session.projectId,
      environmentId: session.environmentId,
    };
    try {
      await this.tenants.require(userId, 'container.exec', scope);
    } catch {
      refused(404);
      return;
    }
    // Another request may have joined it meanwhile: it is refused over HTTP, like any other.
    if (!this.registry.joinable(id, userId)) {
      refused(404);
      return;
    }
    socket.off('error', drop);
    this.sockets.handleUpgrade(request, socket, head, (ws) => {
      this.attach(ws, id, userId, token, scope);
    });
  }

  private attach(ws: WebSocket, id: string, userId: string, token: Secret, scope: Scope): void {
    let told = false;
    const port: BrowserPort = {
      send: (frame) => {
        if (frame.kind === 'exit' || frame.kind === 'error') told = true;
        return send(ws, frame);
      },
      close: (reason) => {
        // The browser learns why, unless the agent's exit or error said it already.
        if (!told && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'end', reason }));
        told = true;
        ws.close(1000);
      },
    };
    const relay = this.registry.joinBrowser(id, userId, port);
    if (!relay) {
      ws.close(4404);
      return;
    }
    ws.on('message', (data, binary) => {
      // Outside Nest's exception handling: whatever a message does, it ends at most its own
      // session, never the process.
      try {
        const frame = browserFrame(data, binary);
        if (frame) relay.fromBrowser(frame);
      } catch {
        this.logger.warn(`exec session ${id}: a browser message could not be read`);
        relay.end('failed', null);
      }
    });
    // Signing out, a password change, or losing container.exec ends the session too. A failure
    // of the store is no refusal: the next check decides.
    const access = setInterval(() => {
      void this.stillAllowed(userId, token, scope).then((answer) => {
        if (answer === 'signed_out' || answer === 'access_removed') relay.end(answer, null);
      });
    }, ACCESS_CHECK_MS);
    access.unref();
    // A browser gone without closing, a laptop asleep, misses its pong: the session ends.
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const keepalive = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, KEEPALIVE_MS);
    keepalive.unref();
    ws.on('close', () => {
      clearInterval(access);
      clearInterval(keepalive);
      relay.browserLeft();
    });
    ws.on('error', () => {
      this.logger.warn(`exec session ${id}: browser connection failed`);
    });
  }

  private async stillAllowed(
    userId: string,
    token: Secret,
    scope: Scope,
  ): Promise<'yes' | 'signed_out' | 'access_removed' | 'unknown'> {
    try {
      await this.sessions.assertLive(userId, token);
    } catch (error) {
      return error instanceof AuthenticationError ? 'signed_out' : 'unknown';
    }
    try {
      await this.tenants.require(userId, 'container.exec', scope);
    } catch (error) {
      return isDomainError(error) ? 'access_removed' : 'unknown';
    }
    return 'yes';
  }

  /**
   * Takes a place in the network's budget for a join about to be checked, or answers false when
   * its refusals of the last minute and the joins it has being checked use the budget up.
   */
  private admit(ip: string, now = Date.now()): boolean {
    const entry = this.failures.get(ip);
    const recent = entry !== undefined && now - entry.since <= 60_000 ? entry.count : 0;
    const checking = this.checking.get(ip) ?? 0;
    if (recent + checking >= FAILED_JOINS_PER_MINUTE) return false;
    this.checking.set(ip, checking + 1);
    return true;
  }

  /** Gives back the place of a join that was checked: the map holds only joins under way. */
  private release(ip: string): void {
    const checking = (this.checking.get(ip) ?? 1) - 1;
    if (checking > 0) this.checking.set(ip, checking);
    else this.checking.delete(ip);
  }

  private failed(ip: string, now = Date.now()): void {
    const entry = this.failures.get(ip);
    if (!entry || now - entry.since > 60_000) this.failures.set(ip, { count: 1, since: now });
    else entry.count++;
    if (this.failures.size > 10_000)
      for (const [key, value] of this.failures)
        if (now - value.since > 60_000) this.failures.delete(key);
  }
}

function refuse(socket: Duplex, status: 401 | 404 | 429 | 500): void {
  const text = {
    401: 'Unauthorized',
    404: 'Not Found',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
  }[status];
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
    // Not JSON: no frame.
    return undefined;
  }
  // Checked flat first, it never throws on what a browser sends; if it ever did, the message
  // handler ends the session as failed and says so in the log.
  return controlFrame(message);
}
