import { computed, inject, Injectable, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';

import { AccessApi, type OrganizationRole } from '../access/access-api';
import { type FleetNode, FleetApi } from '../fleet/fleet-api';
import { IdentityApi, IdentityRequestError } from '../identity/identity-api';
import { SessionStore } from '../identity/session-store';
import { type Organization, type Project, WorkspaceApi } from '../workspace/workspace-api';

const ORGANIZATION = /^\/orgs\/([0-9a-f-]{36})(?:[/?#]|$)/;

export interface ShellProject extends Project {
  /** Number of environments, or null while unknown. */
  readonly environments: number | null;
}

/**
 * What the dashboard frame shows: the current organization (read from the URL), the other
 * organizations of the user, projects, servers, members and the user's second factor.
 */
@Injectable({ providedIn: 'root' })
export class ShellContext {
  private readonly api = inject(WorkspaceApi);
  private readonly fleet = inject(FleetApi);
  private readonly access = inject(AccessApi);
  private readonly identity = inject(IdentityApi);
  private readonly router = inject(Router);
  private readonly session = inject(SessionStore);
  private revision = 0;
  readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );
  readonly public = computed(() => this.url().startsWith('/auth/'));
  readonly organizationId = computed(() => ORGANIZATION.exec(this.url())?.at(1) ?? null);
  readonly organization = signal<Organization | null>(null);
  /** The organization in the URL could not be read: missing, or not this account's. */
  readonly refused = signal(false);
  readonly organizations = signal<readonly Organization[]>([]);
  readonly projects = signal<readonly ShellProject[]>([]);
  readonly nodes = signal<readonly FleetNode[] | null>(null);
  readonly members = signal<number | null>(null);
  /** User id → email, to name the people in audit trails. */
  readonly emails = signal<ReadonlyMap<string, string>>(new Map());
  readonly role = signal<OrganizationRole | null>(null);
  readonly mfa = signal<boolean | null>(null);
  readonly version = signal<string | null>(null);
  /** Agents with a live connection: their server is ready or draining. */
  readonly connected = computed(
    () =>
      this.nodes()?.filter((node) => node.status === 'ready' || node.status === 'draining')
        .length ?? null,
  );

  /** Called on every navigation, so a project created a moment ago appears on the next one. */
  async refresh(): Promise<void> {
    const revision = ++this.revision;
    const id = this.organizationId();
    const profile = this.session.profile();
    if (!id) {
      this.organization.set(null);
      this.projects.set([]);
      this.nodes.set(null);
      this.members.set(null);
      this.role.set(null);
      return;
    }
    const current = () => revision === this.revision;
    void this.loadOnce();
    try {
      const [organization, projects] = await Promise.all([
        this.api.organization(id).catch((error: unknown) => {
          // Only a refused organization earns the message; other failures stay quiet here.
          if (current())
            this.refused.set(
              error instanceof IdentityRequestError && [403, 404].includes(error.status),
            );
          throw error;
        }),
        this.api.projects(id).catch(() => []),
      ]);
      if (!current()) return;
      this.refused.set(false);
      this.organization.set(organization);
      const known = new Map(this.projects().map((project) => [project.id, project.environments]));
      this.projects.set(projects.map((p) => ({ ...p, environments: known.get(p.id) ?? null })));
      void Promise.all(
        projects.map(async (project) => {
          const environments = await this.api.environments(id, project.id).catch(() => null);
          if (!current()) return;
          this.projects.update((all) =>
            all.map((p) =>
              p.id === project.id ? { ...p, environments: environments?.length ?? null } : p,
            ),
          );
        }),
      );
    } catch {
      // The page itself explains a refusal; the frame only stops naming the organization.
      if (!current()) return;
      this.organization.set(null);
      this.projects.set([]);
    }
    const [nodes, members] = await Promise.all([
      this.fleet.nodes(id).catch(() => null),
      this.access.members(id).catch(() => null),
    ]);
    if (!current()) return;
    this.nodes.set(nodes);
    this.members.set(members?.items ? members.items.length : null);
    this.emails.set(new Map((members?.items ?? []).map((m) => [m.userId, m.email])));
    this.role.set(members?.items.find((m) => m.userId === profile?.userId)?.orgRole ?? null);
  }

  private loaded = false;
  /** Values that change rarely: organizations, second factor and the control plane version. */
  private async loadOnce(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const quietly = async <T>(load: () => Promise<T>): Promise<T | null> => {
      try {
        return await load();
      } catch {
        return null;
      }
    };
    const [organizations, mfa, health] = await Promise.all([
      quietly(() => this.api.organizations()),
      quietly(() => this.identity.mfaStatus()),
      quietly(() => this.identity.health()),
    ]);
    if (organizations) this.organizations.set(organizations);
    this.mfa.set(mfa?.enabled ?? null);
    this.version.set(health?.version ?? null);
  }

  /** After the organization list or the second factor changed. */
  invalidate(): void {
    this.loaded = false;
  }
}
