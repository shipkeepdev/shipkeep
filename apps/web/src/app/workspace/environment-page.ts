import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { BindingsPanel } from '../access/bindings-panel';
import { ApplicationsPanel } from '../delivery/applications-panel';
import { SecretsPanel } from '../delivery/secrets-panel';
import { IdentityRequestError } from '../identity/identity-api';
import { ShellContext } from '../shell/shell-context';
import { type Tab, Tabs } from '../shell/tabs';

import { EnvironmentSettings } from './environment-settings';
import { type Environment, WorkspaceApi } from './workspace-api';

/** One environment: its applications and its write-only secrets (M3.4, M3.7b). */
@Component({
  selector: 'sk-environment-page',
  imports: [RouterLink, ApplicationsPanel, BindingsPanel, EnvironmentSettings, SecretsPanel, Tabs],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav aria-label="Breadcrumb" class="breadcrumb">
      <a [routerLink]="['/orgs', organizationId()]">{{
        shell.organization()?.name ?? 'Organization'
      }}</a>
      <span aria-hidden="true">/</span>
      <a [routerLink]="['/orgs', organizationId(), 'projects', projectId()]">{{ projectName() }}</a>
    </nav>
    <section class="max-w-4xl" aria-labelledby="environment-title">
      <h1 id="environment-title">{{ environment()?.name ?? 'Environment' }}</h1>
      @if (missing()) {
        <div class="feedback" role="alert">
          <p>{{ missing() }}</p>
        </div>
      } @else if (environment(); as current) {
        <p class="page-intro">
          {{
            current.protected
              ? 'Protected: only administrators deploy here and set its secrets.'
              : 'Developers can deploy here.'
          }}
        </p>
        <sk-tabs label="Environment sections" [tabs]="tabs" [(active)]="tab" />
        <div
          id="panel-applications"
          role="tabpanel"
          aria-labelledby="tab-applications"
          [hidden]="tab() !== 'applications'"
        >
          <sk-applications-panel [environment]="ref()" />
        </div>
        <div
          id="panel-secrets"
          role="tabpanel"
          aria-labelledby="tab-secrets"
          [hidden]="tab() !== 'secrets'"
        >
          <sk-secrets-panel [environment]="ref()" />
        </div>
        <div
          id="panel-access"
          role="tabpanel"
          aria-labelledby="tab-access"
          [hidden]="tab() !== 'access'"
        >
          <sk-bindings-panel [scope]="ref()" />
        </div>
        <div
          id="panel-settings"
          role="tabpanel"
          aria-labelledby="tab-settings"
          [hidden]="tab() !== 'settings'"
        >
          <sk-environment-settings [current]="current" (updated)="environment.set($event)" />
        </div>
      }
    </section>
  `,
})
export class EnvironmentPage {
  private readonly api = inject(WorkspaceApi);
  protected readonly shell = inject(ShellContext);
  protected readonly tab = signal('applications');
  protected readonly tabs: readonly Tab[] = [
    { id: 'applications', label: 'Applications' },
    { id: 'secrets', label: 'Secrets' },
    { id: 'access', label: 'Access' },
    { id: 'settings', label: 'Settings' },
  ];
  protected readonly projectName = computed(
    () =>
      this.shell.projects().find((project) => project.id === this.projectId())?.name ?? 'Project',
  );
  readonly organizationId = input.required<string>();
  readonly projectId = input.required<string>();
  readonly environmentId = input.required<string>();
  protected readonly environment = signal<Environment | null>(null);
  protected readonly ref = computed(() => ({
    organizationId: this.organizationId(),
    projectId: this.projectId(),
    environmentId: this.environmentId(),
  }));
  protected readonly missing = signal<string | null>(null);

  constructor() {
    effect(() => {
      void this.load(this.organizationId(), this.projectId(), this.environmentId());
    });
  }

  private async load(
    organizationId: string,
    projectId: string,
    environmentId: string,
  ): Promise<void> {
    this.missing.set(null);
    try {
      this.environment.set(await this.api.environment(organizationId, projectId, environmentId));
    } catch (error: unknown) {
      this.environment.set(null);
      this.missing.set(
        error instanceof IdentityRequestError
          ? error.message
          : 'This environment could not be loaded.',
      );
    }
  }
}
