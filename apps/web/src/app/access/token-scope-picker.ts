import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  output,
  signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { type components } from '@shipkeep/api-client';
import { BEARER_GRANTS, type BearerPermission } from '@shipkeep/domain';

import { T } from '../ui/i18n';
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

/** The picker's words for each permission a token can be granted (BEARER_GRANTS, #208). */
const LABELS: Readonly<Record<BearerPermission, string>> = {
  'organization.read': 'Read the organization',
  'organization.update': 'Change organization settings',
  'project.create': 'Create projects',
  'node.manage': 'Remove servers',
  'audit.read': 'Read and export the audit log',
  'project.read': 'Read projects',
  'project.update': 'Change project settings',
  'environment.create': 'Create environments',
  'environment.read': 'Read environments, applications and deployments',
  'environment.update': 'Change environment settings',
  'deploy.run': 'Change applications and deploy them',
  'secret.write': 'Set and remove secrets',
};
/**
 * Permissions a token can use today, each at the one level the tenant policy accepts it: the API
 * refuses the whole token otherwise, even for an owner. The list lives in the domain, and the
 * API's route matrix test ties it to the bearer routes.
 */
const PERMISSIONS: readonly { permission: Permission; level: Level; label: string }[] =
  BEARER_GRANTS.map((grant) => ({ ...grant, label: LABELS[grant.permission] }));
const selected = (event: Event): string => (event.target as HTMLSelectElement).value;

/** Chooses what a new API token may do. Nothing is granted until it is ticked. */
@Component({
  selector: 'sk-token-scope-picker',
  imports: [T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div>
      <label for="token-organization">{{ 'Access' | t }}</label>
      <select
        id="token-organization"
        [value]="organizationId()"
        (change)="chooseOrganization($event)"
      >
        <option value="">{{ 'Only my account profile' | t }}</option>
        @for (organization of organizations.items(); track organization.id) {
          <option [value]="organization.id" [selected]="organization.id === organizationId()">
            {{ organization.name }}
          </option>
        }
      </select>
      @if (organizations.problem(); as problem) {
        <p class="field-error" role="alert">{{ problem | t }}</p>
      }
    </div>
    @if (organizationId()) {
      @if (projects.state() === 'ready') {
        <div>
          <label for="token-project">{{ 'Project' | t }}</label>
          <select id="token-project" [value]="projectId()" (change)="chooseProject($event)">
            <option value="">{{ 'All projects' | t }}</option>
            @for (project of projects.items(); track project.id) {
              <option [value]="project.id" [selected]="project.id === projectId()">
                {{ project.name }}
              </option>
            }
          </select>
        </div>
      }
      @if (projectId() && environments.state() === 'ready') {
        <div>
          <label for="token-environment">{{ 'Environment' | t }}</label>
          <select
            id="token-environment"
            [value]="environmentId()"
            (change)="chooseEnvironment($event)"
          >
            <option value="">{{ 'All environments' | t }}</option>
            @for (environment of environments.items(); track environment.id) {
              <option [value]="environment.id" [selected]="environment.id === environmentId()">
                {{ environment.name }}
              </option>
            }
          </select>
        </div>
      }
      <fieldset class="min-w-0">
        <legend>{{ 'Permissions' | t }}</legend>
        <p class="hint">
          {{
            'What is offered depends on the choice above: deploying and secrets need an environment. A token can never do more than you can.'
              | t
          }}
        </p>
        @for (item of available(); track item.permission) {
          <div class="flex items-center gap-2">
            <input
              type="checkbox"
              [id]="'token-permission-' + item.permission"
              [checked]="ticked().has(item.permission)"
              (change)="toggle(item.permission)"
            />
            <label class="mb-0" [for]="'token-permission-' + item.permission">{{
              item.label | t
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
          <label class="mb-0" for="token-bound">{{ 'Tie this token to the project' | t }}</label>
        </div>
        <p id="token-bound-hint" class="hint">
          {{
            "Project administrators can then see and revoke it, and it is deleted with the project. You need to manage the project's members to do this."
              | t
          }}
        </p>
      }
    } @else {
      <p class="text-sm">{{ 'This token can only read your account profile.' | t }}</p>
    }
  `,
})
export class TokenScopePicker {
  private readonly api = inject(WorkspaceApi);
  private readonly route = inject(ActivatedRoute, { optional: true });
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
    return PERMISSIONS.filter((item) => item.level === level);
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
    const query = this.route?.snapshot.queryParamMap;
    const organizationId = query?.get('organizationId') ?? '';
    const projectId = query?.get('projectId') ?? '';
    const environmentId = query?.get('environmentId') ?? '';
    if (organizationId) {
      this.organizationId.set(organizationId);
      if (projectId) {
        this.projectId.set(projectId);
        if (environmentId) this.environmentId.set(environmentId);
      }
    }
    void this.organizations.refresh();
    if (this.organizationId()) void this.projects.refresh();
    if (this.organizationId() && this.projectId()) void this.environments.refresh();
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
