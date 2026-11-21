import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, createEvent, environmentSettings, NotFoundError } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import {
  resourceActor,
  type ResourceSecurityContext as SecurityContext,
} from '../../identity/application/resource-security-context';
import {
  type EnvironmentRecord,
  type EnvironmentTarget,
  RESOURCE_STORE,
  type ResourceStore,
} from '../../organizations/application/resource-store';
import { TenantAccess } from '../../organizations/application/tenant-access';
import { type Application, clonedConfig } from '../domain/application';

import {
  APPLICATION_STORE,
  APPLICATION_TRANSACTION,
  type ApplicationStore,
  type ApplicationTransaction,
} from './ports';

export interface ClonedEnvironment {
  readonly environment: EnvironmentRecord;
  readonly applications: readonly Application[];
}

/**
 * Clones an environment (issue #257): a new environment of the same project, with the source's
 * settings and a copy of each application's configuration. Nothing else is copied: no secret
 * value, no data, no release or deployment, and no domain, which stays with the application that
 * serves it. The copies are not deployed; the secrets they reference show as not set until someone
 * sets them in the new environment.
 */
@Injectable()
export class EnvironmentClone {
  constructor(
    @Inject(RESOURCE_STORE) private readonly environments: ResourceStore,
    @Inject(APPLICATION_STORE) private readonly applications: ApplicationStore,
    @Inject(APPLICATION_TRANSACTION) private readonly transaction: ApplicationTransaction,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    private readonly events: DomainEventBus,
  ) {}

  clone(
    context: SecurityContext,
    source: EnvironmentTarget,
    name: unknown,
    now = new Date(),
  ): Promise<ClonedEnvironment> {
    const project = { organizationId: source.organizationId, projectId: source.projectId };
    return this.accounts.run(
      context,
      () =>
        this.transaction.runTenant(source.organizationId, async () => {
          // Reading the source, creating an environment, and creating applications in it.
          await this.access.require(context.userId, 'environment.read', source);
          await this.access.require(context.userId, 'environment.create', project);
          const from = await this.environments.findEnvironment(source);
          if (!from) throw new NotFoundError('resource');
          const settings = environmentSettings({
            name,
            kind: from.kind,
            failoverPolicy: from.failoverPolicy,
            protected: from.protected,
          });
          const environment = await this.environments.createEnvironment({
            ...settings,
            id: uuidv7(),
            organizationId: source.organizationId,
            projectId: source.projectId,
            createdAt: now,
            updatedAt: now,
          });
          const actor = resourceActor(context);
          await this.events.publish([
            createEvent({
              type: 'environment.created',
              organizationId: environment.organizationId,
              occurredAt: now,
              actor,
              target: { type: 'environment', id: environment.id },
              payload: { ...settings, projectId: environment.projectId, clonedFrom: from.id },
            }),
          ]);
          const target = { ...project, environmentId: environment.id };
          // An environment-level permission: checked on the new one, inside this transaction.
          await this.access.require(context.userId, 'deploy.run', target);
          const created: Application[] = [];
          for (const original of await this.applications.list(source)) {
            const config = clonedConfig(original.config);
            const copy = await this.applications.create(
              target,
              config,
              createHash('sha256').update(config.canonical, 'utf8').digest('hex'),
              context.userId,
              now,
            );
            // A new environment holds no application yet; a duplicate name means a concurrent write.
            if (!copy) throw new ConflictError('environment_changed', 'Try the clone again.');
            await this.events.publish([
              createEvent({
                type: 'application.created',
                organizationId: copy.organizationId,
                occurredAt: now,
                actor,
                target: { type: 'application', id: copy.id },
                payload: {
                  projectId: copy.projectId,
                  environmentId: copy.environmentId,
                  name: copy.name,
                  source: copy.source,
                  configSha: copy.configSha,
                  clonedFrom: original.id,
                },
              }),
            ]);
            created.push(copy);
          }
          return { environment, applications: created };
        }),
      { permission: 'environment.create', target: project },
    );
  }
}
