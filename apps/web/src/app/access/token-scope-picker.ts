import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  output,
  signal,
} from '@angular/core';
import { type components } from '@shipkeep/api-client';

import { Collection } from '../workspace/collection';
import {
  type Environment,
  type Organization,
  type Project,
  WorkspaceApi,
} from '../workspace/workspace-api';

type Scope = components['schemas']['ApiScopeDto'];
type Permission = Scope['permission'];
type Level = 'organization' | 'project' | 'environment';
/** What a new token may do; `project` ties it to that project (SPEC 7). */
export interface TokenGrant {
  readonly scopes: readonly Scope[];
  readonly project?: { readonly organizationId: string; readonly projectId: string };
}
export const PROFILE_ONLY: TokenGrant = { scopes: [{ permission: 'profile.read' }] };

/**
 * Permissions a token can use today, from docs/generated/route-role-matrix.md, with the narrowest
 * resource each applies to. A scope narrower than that would never match a route, so it is not
 * offered: `audit.read` on one project grants nothing. The rest of the vocabulary has no bearer
 * route yet or is session only, such as `member.manage`.
 */
const PERMISSIONS: readonly { permission: Permission; level: Level; label: string }[] = [
  { permission: 'organization.read', level: 'organization', label: 'Read the organization' },
  {
    permission: 'organization.update',
    level: 'organization',
    label: 'Change organization settings',
  },
  { permission: 'project.create', level: 'organization', label: 'Create projects' },
  { permission: 'node.manage', level: 'organization', label: 'Remove servers' },
  { permission: 'audit.read', level: 'organization', label: 'Read and export the audit log' },
  { permission: 'project.read', level: 'project', label: 'Read projects' },
  { permission: 'project.update', level: 'project', label: 'Change project settings' },
  { permission: 'environment.create', level: 'project', label: 'Create environments' },
  {
    permission: 'environment.read',
    level: 'environment',
    label: 'Read environments, applications and deployments',
  },
  { permission: 'environment.update', level: 'environment', label: 'Change environment settings' },
  {
    permission: 'deploy.run',
    level: 'environment',
    label: 'Change applications and deploy them',
  },
  { permission: 'secret.write', level: 'environment', label: 'Set and remove secrets' },
];
const REACH: Record<Level, readonly Level[]> = {
  organization: ['organization', 'project', 'environment'],
  project: ['project', 'environment'],
  environment: ['environment'],
};
const selected = (event: Event): string => (event.target as HTMLSelectElement).value;

/** Chooses what a new API token may do. Nothing is granted until it is ticked. */
@Component({
  selector: 'sk-token-scope-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div>
      <label for="token-organization">Access</label>
      <select id="token-organization" (change)="chooseOrganization($event)">
        <option value="">Only my account profile</option>
        @for (organization of organizations.items(); track organization.id) {
          <option [value]="organization.id">{{ organization.name }}</option>
        }
      </select>
      @if (organizations.problem(); as problem) {
        <p class="field-error" role="alert">{{ problem }}</p>
      }
    </div>
    @if (organizationId()) {
      @if (projects.state() === 'ready') {
        <div>
          <label for="token-project">Project</label>
          <select id="token-project" (change)="chooseProject($event)">
            <option value="">All projects</option>
            @for (project of projects.items(); track project.id) {
              <option [value]="project.id">{{ project.name }}</option>
            }
          </select>
        </div>
      }
      @if (projectId() && environments.state() === 'ready') {
        <div>
          <label for="token-environment">Environment</label>
          <select id="token-environment" (change)="chooseEnvironment($event)">
            <option value="">All environments</option>
            @for (environment of environments.items(); track environment.id) {
              <option [value]="environment.id">{{ environment.name }}</option>
            }
          </select>
        </div>
      }
      <fieldset class="min-w-0">
        <legend>Permissions</legend>
        <p class="hint">A token can never do more than you can.</p>
        @for (item of available(); track item.permission) {
          <div class="flex items-center gap-2">
            <input
              type="checkbox"
              [id]="'token-permission-' + item.permission"
              [checked]="ticked().has(item.permission)"
              (change)="toggle(item.permission)"
            />
            <label class="mb-0" [for]="'token-permission-' + item.permission">{{
              item.label
            }}</label>
          </div>
        }
      </fieldset>
      @if (projectId()) {
        <div class="flex items-center gap-2">
          <input
            id="token-bound"
            type="checkbox"
            aria-describedby="token-bound-hint"
            [checked]="bound()"
            (change)="bound.set(!bound())"
          />
          <label class="mb-0" for="token-bound">Tie this token to the project</label>
        </div>
        <p id="token-bound-hint" class="hint">
          Project administrators can then see and revoke it, and it is deleted with the project. You
          need to manage the project's members to do this.
        </p>
      }
    } @else {
      <p class="text-sm">This token can only read your account profile.</p>
    }
  `,
})
export class TokenScopePicker {
  private readonly api = inject(WorkspaceApi);
  readonly grantChange = output<TokenGrant>();
  protected readonly organizationId = signal('');
  protected readonly projectId = signal('');
  protected readonly environmentId = signal('');
  protected readonly ticked = signal<ReadonlySet<Permission>>(new Set());
  protected readonly bound = signal(false);
  protected readonly organizations = new Collection<Organization>(() => this.api.organizations());
  protected readonly projects = new Collection<Project>(() =>
    this.api.projects(this.organizationId()),
  );
  protected readonly environments = new Collection<Environment>(() =>
    this.api.environments(this.organizationId(), this.projectId()),
  );
  protected readonly available = computed(() => {
    const level: Level = this.environmentId()
      ? 'environment'
      : this.projectId()
        ? 'project'
        : 'organization';
    return PERMISSIONS.filter((item) => REACH[level].includes(item.level));
  });
  private readonly grant = computed((): TokenGrant => {
    const organizationId = this.organizationId();
    if (!organizationId) return PROFILE_ONLY;
    const projectId = this.projectId();
    const environmentId = this.environmentId();
    const scopes = this.available()
      .filter((item) => this.ticked().has(item.permission))
      .map(({ permission }): Scope => ({
        permission,
        organizationId,
        ...(projectId ? { projectId } : {}),
        ...(environmentId ? { environmentId } : {}),
      }));
    return {
      scopes,
      ...(projectId && this.bound() ? { project: { organizationId, projectId } } : {}),
    };
  });

  constructor() {
    void this.organizations.refresh();
    effect(() => {
      this.grantChange.emit(this.grant());
    });
  }

  protected chooseOrganization(event: Event): void {
    this.organizationId.set(selected(event));
    this.clearProject();
    this.ticked.set(new Set());
    if (this.organizationId()) void this.projects.refresh();
  }
  protected chooseProject(event: Event): void {
    this.clearProject();
    this.projectId.set(selected(event));
    if (this.projectId()) void this.environments.refresh();
  }
  protected chooseEnvironment(event: Event): void {
    this.environmentId.set(selected(event));
  }
  protected toggle(permission: Permission): void {
    this.ticked.update((current) => {
      const next = new Set(current);
      if (!next.delete(permission)) next.add(permission);
      return next;
    });
  }

  private clearProject(): void {
    this.projectId.set('');
    this.environmentId.set('');
    this.bound.set(false);
  }
}
