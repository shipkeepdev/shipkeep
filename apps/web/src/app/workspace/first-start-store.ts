import { Injectable, inject, signal } from '@angular/core';

import { leftLive } from '../dashboard/format';
import { DeliveryApi, type EnvironmentRef } from '../delivery/delivery-api';
import { FleetApi } from '../fleet/fleet-api';

import { WorkspaceApi } from './workspace-api';

/** Deployment lists read at once while looking for one that served. */
const BATCH = 8;

export interface FirstStartRead {
  /** Null when the list could not be read. */
  readonly servers: number | null;
  readonly readyServers: number;
  readonly applications: number | null;
  /** Whether any application served once; null when that could not be read. */
  readonly deployed: boolean | null;
}

/**
 * The facts of a first start (#269), read for the checklist alone: every application, not the
 * Overview's first forty, and the search for a deployment that served stops at the first one.
 */
@Injectable()
export class FirstStartStore {
  private readonly workspace = inject(WorkspaceApi);
  private readonly delivery = inject(DeliveryApi);
  private readonly fleet = inject(FleetApi);
  private revision = 0;
  readonly loading = signal(true);
  readonly facts = signal<FirstStartRead>({
    servers: null,
    readyServers: 0,
    applications: null,
    deployed: null,
  });

  async load(organizationId: string): Promise<void> {
    const revision = ++this.revision;
    this.loading.set(true);
    const [nodes, applications] = await Promise.allSettled([
      this.fleet.nodes(organizationId),
      this.applications(organizationId),
    ]);
    const deployed =
      applications.status === 'fulfilled'
        ? await this.anyServed(applications.value).catch(() => null)
        : null;
    if (revision !== this.revision) return;
    const servers = nodes.status === 'fulfilled' ? nodes.value : null;
    this.facts.set({
      servers: servers ? servers.length : null,
      readyServers: servers?.filter((node) => node.status === 'ready').length ?? 0,
      applications: applications.status === 'fulfilled' ? applications.value.length : null,
      deployed,
    });
    this.loading.set(false);
  }

  private async applications(
    organizationId: string,
  ): Promise<{ readonly ref: EnvironmentRef; readonly id: string }[]> {
    const projects = await this.workspace.projects(organizationId);
    const environments = (
      await Promise.all(
        projects.map(async (project) =>
          (await this.workspace.environments(organizationId, project.id)).map((environment) => ({
            organizationId,
            projectId: project.id,
            environmentId: environment.id,
          })),
        ),
      )
    ).flat();
    return (
      await Promise.all(
        environments.map(async (ref) =>
          (await this.delivery.applications(ref)).map((application) => ({
            ref,
            id: application.id,
          })),
        ),
      )
    ).flat();
  }

  private async anyServed(
    applications: readonly { readonly ref: EnvironmentRef; readonly id: string }[],
  ): Promise<boolean> {
    for (let start = 0; start < applications.length; start += BATCH) {
      const found = await Promise.all(
        applications
          .slice(start, start + BATCH)
          .map(async ({ ref, id }) => (await this.delivery.deployments(ref, id)).some(leftLive)),
      );
      if (found.includes(true)) return true;
    }
    return false;
  }
}
