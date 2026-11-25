import { createSecureServer, type Http2SecureServer, type ServerHttp2Session } from 'node:http2';
import { TLSSocket } from 'node:tls';

import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import {
  Code,
  ConnectError,
  createContextKey,
  createContextValues,
  type Interceptor,
} from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { isDomainError, Secret } from '@shipkeep/domain';
import { AgentGatewayService } from '@shipkeep/proto-ts';

import { NodeStream } from './node-stream';

import { AppConfig } from '../../../platform/config/app-config';
import { AuthenticateNode } from '../application/authenticate-node';
import { EnrollNode } from '../application/enroll-node';
import { factsFromProto } from '../application/node-facts';
import { RenewNodeCertificate } from '../application/renew-node-certificate';
import { parseNodeSpiffeId } from '../domain/node';
import { ExecSessionRegistry } from '../application/exec-relay';
import { NodeAuthenticationError, type NodeIdentity } from '../domain/node-identity';
import { CsrError } from '../infrastructure/ca/x509';
import { X509CertificateAuthority } from '../infrastructure/ca/x509-certificate-authority';
import { EnrollmentAdmission, enrollmentBusy } from './enrollment-admission';
import { relayExecStream } from './exec-stream';
import { gatewaySecureContext } from './gateway-tls';
import { LogStreams } from './log-stream';

const peer = createContextKey<TLSSocket | undefined>(undefined);
const identity = createContextKey<NodeIdentity | undefined>(undefined);

/** Optional client certificates at TLS level permit Enroll; every other RPC is default-deny. */
@Injectable()
export class AgentGateway implements OnModuleDestroy {
  private readonly logger = new Logger(AgentGateway.name);
  private server?: Http2SecureServer;
  private refresh?: NodeJS.Timeout;
  private readonly sessions = new Set<ServerHttp2Session>();

  constructor(
    private readonly config: AppConfig,
    private readonly ca: X509CertificateAuthority,
    private readonly authenticate: AuthenticateNode,
    private readonly enroll: EnrollNode,
    private readonly renew: RenewNodeCertificate,
    private readonly streams: NodeStream,
    private readonly admission: EnrollmentAdmission,
    private readonly logStreams: LogStreams,
    private readonly exec: ExecSessionRegistry,
  ) {}

  /** Called explicitly after Nest initialization; OpenAPI generation never opens this listener. */
  async start(): Promise<void> {
    if (this.server) throw new Error('agent gateway already started');
    const credentials = await this.ca.gatewayCredentials(
      this.config.get('AGENT_GATEWAY_SERVER_NAME'),
    );
    const adapter = connectNodeAdapter({
      grpc: true,
      grpcWeb: false,
      connect: false,
      readMaxBytes: 64 * 1024,
      writeMaxBytes: 64 * 1024,
      maxTimeoutMs: 30_000,
      interceptors: [this.guard()],
      contextValues: (req) =>
        createContextValues().set(peer, req.socket instanceof TLSSocket ? req.socket : undefined),
      routes: (router) => {
        router.rpc(AgentGatewayService.method.enroll, async (request, context) => {
          // Before any database work (#346): the quota of the caller's network, the shape of the
          // request, then the budget of enrollments at once, shared by every connection.
          const ip = context.values.get(peer)?.remoteAddress;
          if (!this.admission.allow(ip)) throw enrollmentBusy();
          const command = {
            joinToken: new Secret(request.joinToken),
            csrPem: request.csrPem,
            facts: factsFromProto(request.facts),
            agentVersion: request.agentVersion,
            ip,
          };
          this.enroll.validate(command);
          const result = await this.admission.run(
            () => this.enroll.execute(command),
            context.signal,
          );
          return {
            certPem: result.certificatePem,
            caPem: result.caPem,
            nodeId: result.nodeId,
            organizationId: result.organizationId,
            leaseEpoch: BigInt(result.leaseEpoch),
            confirmationPublicKey: result.confirmationPublicKeyPem,
            certNotAfter: timestampFromDate(result.certificateNotAfter),
          };
        });
        router.rpc(AgentGatewayService.method.renewCertificate, async (request, context) => {
          const authenticated = context.values.get(identity);
          if (!authenticated) throw new NodeAuthenticationError();
          const result = await this.renew.execute(authenticated, request.csrPem);
          return {
            certPem: result.certificatePem,
            certNotAfter: timestampFromDate(result.notAfter),
          };
        });
        router.rpc(
          AgentGatewayService.method.connect,
          (request, context) => {
            const authenticated = context.values.get(identity);
            if (!authenticated)
              throw new ConnectError('node authentication required', Code.Unauthenticated);
            return this.streams.connect(request, context, authenticated);
          },
          { maxTimeoutMs: 24 * 60 * 60_000 },
        );
        // Container logs (ADR 0029), after the shared authentication guard.
        router.rpc(
          AgentGatewayService.method.shipLogs,
          (requests, context) => {
            const authenticated = context.values.get(identity);
            if (!authenticated)
              throw new ConnectError('node authentication required', Code.Unauthenticated);
            return this.logStreams.ship(requests, context, authenticated);
          },
          { maxTimeoutMs: 24 * 60 * 60_000 },
        );
        // An exec session's frames (SPEC 3.1), after the shared authentication guard.
        router.rpc(
          AgentGatewayService.method.execStream,
          (requests, context) => {
            const authenticated = context.values.get(identity);
            if (!authenticated)
              throw new ConnectError('node authentication required', Code.Unauthenticated);
            return relayExecStream(this.exec, requests, authenticated, () =>
              this.authenticate.execute(authenticated),
            );
          },
          { maxTimeoutMs: 24 * 60 * 60_000 },
        );
      },
    });
    const server = createSecureServer(
      // Server-side optional client auth is required for Enroll (SPEC 3.2). guard() checks
      // socket.authorized plus database identity on all other RPCs; rogue-CA tests cover this.
      // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
      {
        ...gatewaySecureContext(credentials),
        requestCert: true,
        rejectUnauthorized: false,
        allowHTTP1: false,
        settings: { maxConcurrentStreams: 32 },
      },
      adapter,
    );
    this.server = server;
    server.on('session', (session) => {
      this.sessions.add(session);
      session.on('error', () => {
        session.destroy();
      });
      session.once('close', () => {
        this.sessions.delete(session);
      });
      session.setTimeout(60_000, () => {
        session.destroy();
      });
    });
    const [host, port] = this.config.get('AGENT_GATEWAY_ADDR').split(':');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(port), host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.refresh = setInterval(
      () => {
        void this.refreshCertificate();
      },
      24 * 60 * 60_000,
    );
    this.refresh.unref();
    this.logger.log('agent gateway listening over TLS');
  }

  address(): ReturnType<Http2SecureServer['address']> {
    return this.server?.address() ?? null;
  }

  private guard(): Interceptor {
    return (next) => async (request) => {
      try {
        if (request.method.name !== 'Enroll') {
          const socket = request.contextValues.get(peer);
          const certificate = socket?.getPeerX509Certificate();
          const parsed = certificate?.subjectAltName?.startsWith('URI:')
            ? parseNodeSpiffeId(certificate.subjectAltName.slice(4))
            : undefined;
          if (
            !socket?.authorized ||
            !certificate ||
            !parsed ||
            !certificate.keyUsage.includes('1.3.6.1.5.5.7.3.2')
          )
            throw new NodeAuthenticationError();
          const authenticated = {
            ...parsed,
            serial: certificate.serialNumber.toLowerCase().padStart(32, '0'),
          };
          await this.authenticate.execute(authenticated);
          request.contextValues.set(identity, authenticated);
        }
        return await next(request);
      } catch (error: unknown) {
        if (error instanceof ConnectError) throw error;
        if (error instanceof CsrError)
          throw new ConnectError('invalid certificate request', Code.InvalidArgument);
        if (isDomainError(error))
          throw new ConnectError(
            error.message,
            error.kind === 'unauthorized'
              ? Code.Unauthenticated
              : error.kind === 'conflict'
                ? Code.AlreadyExists
                : Code.InvalidArgument,
          );
        throw new ConnectError('agent gateway request failed', Code.Internal);
      }
    };
  }

  private async refreshCertificate(): Promise<void> {
    try {
      const credentials = await this.ca.gatewayCredentials(
        this.config.get('AGENT_GATEWAY_SERVER_NAME'),
      );
      this.server?.setSecureContext(gatewaySecureContext(credentials));
    } catch {
      this.logger.error('agent gateway certificate refresh failed');
    }
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.refresh);
    for (const session of this.sessions) session.destroy();
    const server = this.server;
    this.server = undefined;
    if (server?.listening)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
  }
}
