import { create } from '@bufbuild/protobuf';
import { DurationSchema } from '@bufbuild/protobuf/wkt';
import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, createEvent, NotFoundError } from '@shipkeep/domain';
import { ExecSessionSchema } from '@shipkeep/proto-ts';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { APPLICATION_STORE, type ApplicationStore } from '../../apps/application/ports';
import type { ApplicationTarget } from '../../apps/domain/application';
import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import {
  resourceActor,
  type ResourceSecurityContext as SecurityContext,
} from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import { auditedCommand, EXEC_ATTACH_MS, execRequest } from '../domain/exec-session';

import {
  ACTION_QUEUE,
  type ActionQueue,
  DEPLOYMENT_TRANSACTION,
  type DeploymentTransaction,
  OBSERVATION_STORE,
  type ObservationStore,
} from './ports';

/** A session waiting for the browser and the agent to join it, then relayed between them. */
export interface ExecSession {
  readonly id: string;
  readonly organizationId: string;
  readonly applicationId: string;
  readonly userId: string;
  readonly nodeId: string;
  readonly container: string;
  readonly tty: boolean;
  /** Until when the browser and the agent may join. */
  readonly attachBy: Date;
  /** When the agent ends it, whatever happens. */
  readonly endsAt: Date;
}

/**
 * Sessions opened on this API process. A session lives only as long as both its connections,
 * which both reach this process, so it is never stored: a restart ends it, and the agent's
 * action ends with its stream.
 */
@Injectable()
export class ExecSessionRegistry {
  private readonly sessions = new Map<string, ExecSession>();

  add(session: ExecSession): void {
    this.sessions.set(session.id, session);
  }

  /** The session, while it may still be joined. */
  pending(id: string, now = new Date()): ExecSession | undefined {
    this.prune(now);
    return this.sessions.get(id);
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  private prune(now: Date): void {
    for (const [id, session] of this.sessions)
      if (session.attachBy.getTime() <= now.getTime()) this.sessions.delete(id);
  }
}

/** Opens exec sessions in an application's replicas (SPEC 3.1, M6.1). */
@Injectable()
export class ExecSessions {
  constructor(
    @Inject(DEPLOYMENT_TRANSACTION) private readonly transaction: DeploymentTransaction,
    @Inject(APPLICATION_STORE) private readonly applications: ApplicationStore,
    @Inject(OBSERVATION_STORE) private readonly observations: ObservationStore,
    @Inject(ACTION_QUEUE) private readonly actions: ActionQueue,
    private readonly registry: ExecSessionRegistry,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    private readonly events: DomainEventBus,
  ) {}

  /**
   * Opens a session in one running replica: queues the agent's `ExecSession` and keeps the
   * session until the browser and the agent join it. `container.exec` is denied on a protected
   * environment to everyone but its administrators (SPEC 7).
   */
  async open(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    input: Parameters<typeof execRequest>[0],
    now = new Date(),
  ): Promise<ExecSession> {
    const request = execRequest(input);
    const scope = {
      organizationId: target.organizationId,
      projectId: target.projectId,
      environmentId: target.environmentId,
    };
    return this.accounts.run(
      context,
      async () => {
        await this.access.require(context.userId, 'container.exec', scope);
        const opened = await this.transaction.runTenant(target.organizationId, async () => {
          const application = await this.applications.find(target, applicationId);
          if (!application) throw new NotFoundError('application');
          const replicas = await this.observations.forApplication(application.id);
          // During a rollout two releases share a replica number: the running one, newest first.
          const replica = replicas
            .filter((found) => found.replica === request.replica && found.state === 'running')
            .sort((a, b) => b.releaseId.localeCompare(a.releaseId))
            .at(0);
          if (!replica)
            throw new ConflictError('replica_not_running', 'This replica is not running.', {
              replica: request.replica,
            });
          const id = uuidv7();
          const limitMs = request.minutes * 60_000;
          const session: ExecSession = {
            id,
            organizationId: application.organizationId,
            applicationId: application.id,
            userId: context.userId,
            nodeId: replica.nodeId,
            container: replica.container,
            tty: request.tty,
            attachBy: new Date(now.getTime() + EXEC_ATTACH_MS),
            endsAt: new Date(now.getTime() + EXEC_ATTACH_MS + limitMs),
          };
          await this.actions.enqueue({
            organizationId: application.organizationId,
            nodeId: replica.nodeId,
            idempotencyKey: `exec:${id}`,
            action: {
              case: 'execSession',
              value: create(ExecSessionSchema, {
                containerId: replica.container,
                argv: [...request.argv],
                tty: request.tty,
                sessionId: id,
                timeLimit: create(DurationSchema, { seconds: BigInt(limitMs / 1000) }),
              }),
            },
            // Delivered within the attach window; the agent then ends it at its time limit.
            deadline: session.endsAt,
            actor: resourceActor(context),
          });
          await this.events.publish([
            createEvent({
              type: 'exec.session.opened',
              organizationId: application.organizationId,
              actor: resourceActor(context),
              target: { type: 'exec_session', id },
              payload: {
                projectId: application.projectId,
                environmentId: application.environmentId,
                applicationId: application.id,
                nodeId: replica.nodeId,
                replica: request.replica,
                tty: request.tty,
                minutes: request.minutes,
                ...auditedCommand(request.argv),
              },
              occurredAt: now,
            }),
          ]);
          return session;
        });
        // Joinable once its action and audit event are committed.
        this.registry.add(opened);
        return opened;
      },
      { permission: 'container.exec', target: scope },
    );
  }
}
