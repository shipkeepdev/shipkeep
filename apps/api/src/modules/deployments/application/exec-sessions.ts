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
import { type ExecSession, ExecSessionRegistry } from '../../fleet/application/exec-relay';
import {
  auditedCommand,
  EXEC_ATTACH_MS,
  EXEC_FRESH_MS,
  EXEC_SESSIONS_PER_ORGANIZATION,
  EXEC_SESSIONS_PER_USER,
  execRequest,
} from '../domain/exec-session';

import {
  ACTION_QUEUE,
  type ActionQueue,
  DEPLOYMENT_TRANSACTION,
  type DeploymentTransaction,
  OBSERVATION_STORE,
  type ObservationStore,
} from './ports';

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
        if (
          this.registry.count({ userId: context.userId }, now) >= EXEC_SESSIONS_PER_USER ||
          this.registry.count({ organizationId: target.organizationId }, now) >=
            EXEC_SESSIONS_PER_ORGANIZATION
        )
          throw new ConflictError('exec_sessions_limit', 'Too many exec sessions are open.');
        const opened = await this.transaction.runTenant(target.organizationId, async () => {
          const application = await this.applications.find(target, applicationId);
          if (!application) throw new NotFoundError('application');
          const replicas = await this.observations.forApplication(application.id);
          // During a rollout two releases share a replica number: the running one, newest first.
          const replica = replicas
            .filter(
              (found) =>
                found.replica === request.replica &&
                found.state === 'running' &&
                // An old observation may describe a server that is down.
                found.observedAt !== null &&
                now.getTime() - found.observedAt.getTime() <= EXEC_FRESH_MS,
            )
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
            // Expires with the join window: an agent that reconnects later never runs it with
            // nobody there. Once started, the agent ends it at its own time limit.
            deadline: session.attachBy,
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
        this.registry.add(opened, now);
        return opened;
      },
      { permission: 'container.exec', target: scope },
    );
  }
}
