import { computed, inject, Injectable, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';

import { SessionStore } from '../identity/session-store';
import { type Organization, type Project, WorkspaceApi } from '../workspace/workspace-api';

const ORGANIZATION = /^\/orgs\/([0-9a-f-]{36})(?:[/?#]|$)/;

/** What the sidebar shows: the current organization, read from the URL, and its projects. */
@Injectable({ providedIn: 'root' })
export class ShellContext {
  private readonly api = inject(WorkspaceApi);
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
  readonly projects = signal<readonly Project[]>([]);

  /** Called on every navigation, so a project created a moment ago appears on the next one. */
  async refresh(): Promise<void> {
    const revision = ++this.revision;
    const id = this.organizationId();
    if (!id || !this.session.profile()) {
      this.organization.set(null);
      this.projects.set([]);
      return;
    }
    try {
      const [organization, projects] = await Promise.all([
        this.api.organization(id),
        this.api.projects(id),
      ]);
      if (revision !== this.revision) return;
      this.organization.set(organization);
      this.projects.set(projects);
    } catch {
      // The page itself explains a refusal; the sidebar only stops naming the organization.
      if (revision !== this.revision) return;
      this.organization.set(null);
      this.projects.set([]);
    }
  }
}
