import { Inject, Injectable } from '@nestjs/common';
import {
  createEvent,
  environmentSettings,
  projectSettings,
  type EnvironmentSettingsInput,
  type ProjectSettingsInput,
  type ResourceContext,
  type Permission,
} from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import {
  resourceActor,
  type ResourceSecurityContext as SecurityContext,
} from '../../identity/application/resource-security-context';

import {
  RESOURCE_STORE,
  type ResourceStore,
  type ProjectRecord,
  type ProjectTarget,
  type EnvironmentRecord,
  type EnvironmentTarget,
} from './resource-store';
import { TenantAccess } from './tenant-access';

@Injectable()
export class ResourceCommands {
  constructor(
    @Inject(RESOURCE_STORE) private readonly store: ResourceStore,
    private readonly authority: AccountMutationAuthority,
    private readonly access: TenantAccess,
    private readonly events: DomainEventBus,
  ) {}

  async createProject(
    context: SecurityContext,
    organizationId: string,
    input: ProjectSettingsInput,
    now = new Date(),
  ): Promise<ProjectRecord> {
    const settings = projectSettings(input);
    return this.execute(
      context,
      { organizationId },
      'project.create',
      'project.created',
      { ...settings },
      () =>
        this.store.createProject({
          ...settings,
          id: uuidv7(),
          organizationId,
          createdAt: now,
          updatedAt: now,
        }),
      now,
    );
  }
  async updateProject(
    context: SecurityContext,
    target: ProjectTarget,
    input: ProjectSettingsInput,
    now = new Date(),
  ): Promise<ProjectRecord> {
    const settings = projectSettings(input);
    return this.execute(
      context,
      target,
      'project.update',
      'project.updated',
      { ...settings },
      () => this.store.updateProject(target, settings, now),
      now,
    );
  }
  async createEnvironment(
    context: SecurityContext,
    target: ProjectTarget,
    input: EnvironmentSettingsInput,
    now = new Date(),
  ): Promise<EnvironmentRecord> {
    const settings = environmentSettings(input);
    return this.execute(
      context,
      target,
      'environment.create',
      'environment.created',
      { ...settings },
      () =>
        this.store.createEnvironment({
          ...settings,
          id: uuidv7(),
          organizationId: target.organizationId,
          projectId: target.projectId,
          createdAt: now,
          updatedAt: now,
        }),
      now,
    );
  }
  async updateEnvironment(
    context: SecurityContext,
    target: EnvironmentTarget,
    input: EnvironmentSettingsInput,
    now = new Date(),
  ): Promise<EnvironmentRecord> {
    const settings = environmentSettings(input);
    return this.execute(
      context,
      target,
      'environment.update',
      'environment.updated',
      { ...settings },
      () => this.store.updateEnvironment(target, settings, now),
      now,
    );
  }
  private execute<T extends { readonly id: string }>(
    context: SecurityContext,
    target: ResourceContext & { organizationId: string },
    permission: Permission,
    action: 'project.created' | 'project.updated' | 'environment.created' | 'environment.updated',
    settings: Record<string, unknown>,
    operation: () => Promise<T>,
    now: Date,
  ): Promise<T> {
    return this.authority.run(
      context,
      () =>
        this.store.transaction(target.organizationId, async () => {
          await this.access.require(context.userId, permission, target);
          const record = await operation();
          await this.events.publish([
            createEvent({
              type: action,
              organizationId: target.organizationId,
              occurredAt: now,
              actor: resourceActor(context),
              target: {
                type: action.startsWith('project.') ? 'project' : 'environment',
                id: record.id,
              },
              payload: {
                ...settings,
                ...(target.projectId ? { projectId: target.projectId } : {}),
              },
            }),
          ]);
          return record;
        }),
      { permission, target },
    );
  }
}
