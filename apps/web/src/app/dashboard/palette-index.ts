import { inject, Injectable } from '@angular/core';

import { AccessApi, type Member } from '../access/access-api';
import { DeliveryApi } from '../delivery/delivery-api';
import { FleetApi } from '../fleet/fleet-api';
import { WorkspaceApi } from '../workspace/workspace-api';

import type { PaletteEntry } from './command-palette';

/** Bounds on one palette opening: the requests it makes, not what the search may find. */
const MAX_ENVIRONMENTS = 60;
const MEMBER_PAGES = 5;

/**
 * What ⌘K can find besides pages (issue #271): environments, applications, servers and members.
 * Everything comes from the lists this account may already read; a list it may not read is
 * left out, so nothing it cannot see is ever offered.
 */
@Injectable({ providedIn: 'root' })
export class PaletteIndex {
  private readonly workspace = inject(WorkspaceApi);
  private readonly delivery = inject(DeliveryApi);
  private readonly fleet = inject(FleetApi);
  private readonly access = inject(AccessApi);

  async load(organizationId: string): Promise<PaletteEntry[]> {
    const org = ['/orgs', organizationId];
    const [projects, nodes, members] = await Promise.all([
      quietly(this.workspace.projects(organizationId), []),
      quietly(this.fleet.nodes(organizationId), []),
      quietly(this.members(organizationId), []),
    ]);
    const places = (
      await Promise.all(
        projects.map(async (project) =>
          (await quietly(this.workspace.environments(organizationId, project.id), [])).map(
            (environment) => ({ project, environment }),
          ),
        ),
      )
    )
      .flat()
      .slice(0, MAX_ENVIRONMENTS);
    const applications = (
      await Promise.all(
        places.map(async ({ project, environment }) => {
          const ref = { organizationId, projectId: project.id, environmentId: environment.id };
          return (await quietly(this.delivery.applications(ref), [])).map((application) => ({
            project,
            environment,
            application,
          }));
        }),
      )
    ).flat();
    return [
      ...places.map(({ project, environment }): PaletteEntry => ({
        label: environment.name,
        detail: project.name,
        raw: true,
        icon: 'stack-2',
        link: [...org, 'projects', project.id, 'environments', environment.id],
      })),
      ...applications.map(({ project, environment, application }): PaletteEntry => ({
        label: application.name,
        detail: `${project.name} · ${environment.name}`,
        raw: true,
        icon: 'box',
        link: [
          ...org,
          'projects',
          project.id,
          'environments',
          environment.id,
          'applications',
          application.id,
        ],
      })),
      ...nodes
        .filter((node) => node.status !== 'removed')
        .map((node): PaletteEntry => ({
          label: node.name,
          raw: true,
          icon: 'server-2',
          link: [...org, 'servers'],
        })),
      ...members.map((member): PaletteEntry => ({
        label: member.email,
        raw: true,
        icon: 'users',
        link: [...org, 'members'],
      })),
    ];
  }

  private async members(organizationId: string): Promise<Member[]> {
    const all: Member[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MEMBER_PAGES; page++) {
      const { items, nextCursor } = await this.access.members(organizationId, cursor);
      all.push(...items);
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    return all;
  }
}

/** A list this account may not read (or that failed) adds nothing. */
function quietly<T>(request: Promise<T>, fallback: T): Promise<T> {
  return request.catch(() => fallback);
}
