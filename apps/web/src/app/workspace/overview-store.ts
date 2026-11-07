import { computed, inject, Injectable, signal } from '@angular/core';

import { AuditApi, type AuditEvent } from '../audit/audit-api';
import { DeliveryApi, type Deployment } from '../delivery/delivery-api';
import { FleetApi, type FleetNode } from '../fleet/fleet-api';

import { WorkspaceApi } from './workspace-api';

/** Enough for a summary, and a bound on the requests one page view makes. */
const MAX_APPLICATIONS = 40;
const RECENT_DEPLOYMENTS = 8;
const RECENT_EVENTS = 6;

export interface ApplicationRow {
  readonly id: string;
  readonly name: string;
  readonly project: string;
  readonly environment: string;
  readonly link: readonly string[];
  /** Most recent first. */
  readonly deployments: readonly Deployment[];
}
export interface DeploymentRow {
  readonly application: ApplicationRow;
  readonly deployment: Deployment;
}

/** What an organization's overview shows. All of it comes from the API; nothing is estimated. */
@Injectable()
export class OverviewStore {
  private readonly workspace = inject(WorkspaceApi);
  private readonly delivery = inject(DeliveryApi);
  private readonly fleet = inject(FleetApi);
  private readonly audit = inject(AuditApi);
  private revision = 0;
  readonly loading = signal(true);
  /** Null when this account may not see them: the panel is then left out, not shown empty. */
  readonly nodes = signal<readonly FleetNode[] | null>(null);
  readonly events = signal<readonly AuditEvent[] | null>(null);
  readonly environmentCount = signal(0);
  readonly projectCount = signal(0);
  readonly applications = signal<readonly ApplicationRow[]>([]);
  readonly readyNodes = computed(
    () => (this.nodes() ?? []).filter((node) => node.status === 'ready').length,
  );
  readonly failing = computed(
    () =>
      this.applications().filter((application) => application.deployments.at(0)?.state === 'failed')
        .length,
  );
  readonly recent = computed((): readonly DeploymentRow[] =>
    this.applications()
      .flatMap((application) =>
        application.deployments.map((deployment) => ({ application, deployment })),
      )
      .sort((left, right) => right.deployment.startedAt.localeCompare(left.deployment.startedAt))
      .slice(0, RECENT_DEPLOYMENTS),
  );

  async load(organizationId: string): Promise<void> {
    const revision = ++this.revision;
    this.loading.set(true);
    const [nodes, events, tree] = await Promise.allSettled([
      this.fleet.nodes(organizationId),
      this.recentEvents(organizationId),
      this.applicationTree(organizationId),
    ]);
    if (revision !== this.revision) return;
    this.nodes.set(nodes.status === 'fulfilled' ? nodes.value : null);
    this.events.set(events.status === 'fulfilled' ? events.value : null);
    if (tree.status === 'fulfilled') {
      this.projectCount.set(tree.value.projects);
      this.environmentCount.set(tree.value.environments);
      this.applications.set(tree.value.applications);
    } else {
      this.projectCount.set(0);
      this.environmentCount.set(0);
      this.applications.set([]);
    }
    this.loading.set(false);
  }

  private async recentEvents(organizationId: string): Promise<readonly AuditEvent[]> {
    return (await this.audit.page(organizationId, {})).items.slice(0, RECENT_EVENTS);
  }

  private async applicationTree(organizationId: string): Promise<{
    projects: number;
    environments: number;
    applications: readonly ApplicationRow[];
  }> {
    const projects = await this.workspace.projects(organizationId);
    const perProject = await Promise.all(
      projects.map(async (project) => ({
        project,
        environments: await this.workspace.environments(organizationId, project.id),
      })),
    );
    const places = perProject.flatMap(({ project, environments }) =>
      environments.map((environment) => ({ project, environment })),
    );
    const perEnvironment = await Promise.all(
      places.map(async ({ project, environment }) => {
        const ref = { organizationId, projectId: project.id, environmentId: environment.id };
        const applications = await this.delivery.applications(ref);
        return applications.map((application) => ({ ref, project, environment, application }));
      }),
    );
    const applications = await Promise.all(
      perEnvironment
        .flat()
        .slice(0, MAX_APPLICATIONS)
        .map(async ({ ref, project, environment, application }): Promise<ApplicationRow> => ({
          id: application.id,
          name: application.name,
          project: project.name,
          environment: environment.name,
          link: [
            '/orgs',
            organizationId,
            'projects',
            project.id,
            'environments',
            environment.id,
            'applications',
            application.id,
          ],
          deployments: await this.delivery.deployments(ref, application.id),
        })),
    );
    return { projects: projects.length, environments: places.length, applications };
  }
}
