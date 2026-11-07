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
import { PageCrumbs } from '../dashboard/page-crumbs';
import { Icon } from '../shell/icon';
import { ShellContext } from '../shell/shell-context';
import { T } from '../ui/i18n';
import { Notice } from '../ui/notice';
import { type Tab, Tabs } from '../shell/tabs';

import { EnvironmentSettings } from './environment-settings';
import { type Environment, WorkspaceApi } from './workspace-api';

/** One environment: its applications and its write-only secrets (M3.4, M3.7b). */
@Component({
  selector: 'sk-environment-page',
  imports: [
    ApplicationsPanel,
    BindingsPanel,
    EnvironmentSettings,
    Icon,
    RouterLink,
    SecretsPanel,
    T,
    Tabs,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page gap-[18px]">
      <div class="page-head">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-3">
            <h1 class="page-title">{{ environment()?.name ?? '…' }}</h1>
            @if (environment()?.protected) {
              <span class="pill text-rose"
                ><span class="dot bg-rose"></span>{{ 'protected' | t }}</span
              >
            }
          </div>
          <div class="mt-1.5 max-w-[720px] text-[13px] text-mute2">
            {{ projectName() }} ·
            {{
              (environment()?.protected
                ? 'Protected: only administrators deploy here and set its secrets.'
                : 'Developers can deploy here.'
              ) | t
            }}
          </div>
        </div>
        <div class="flex flex-wrap gap-2.5">
          <button type="button" class="btn" (click)="notice.notYet('Clone')">
            <sk-icon name="copy" />{{ 'Clone' | t }}
          </button>
          <button type="button" class="btn" (click)="tab.set('secrets')">
            <sk-icon name="key" />{{ 'Variables' | t }}
          </button>
          <a
            class="btn btn-primary"
            [routerLink]="['/orgs', organizationId(), 'new']"
            [queryParams]="{ project: projectId(), environment: environmentId() }"
            ><sk-icon name="plus" />{{ 'New resource' | t }}</a
          >
        </div>
      </div>
      @if (missing()) {
        <div class="alert" role="alert">{{ missing() | t }}</div>
      } @else if (environment(); as current) {
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
          class="legacy-form"
          [hidden]="tab() !== 'secrets'"
        >
          <sk-secrets-panel [environment]="ref()" />
        </div>
        <div
          id="panel-access"
          role="tabpanel"
          aria-labelledby="tab-access"
          class="legacy-form"
          [hidden]="tab() !== 'access'"
        >
          <sk-bindings-panel [scope]="ref()" />
        </div>
        <div
          id="panel-settings"
          role="tabpanel"
          aria-labelledby="tab-settings"
          class="legacy-form"
          [hidden]="tab() !== 'settings'"
        >
          <sk-environment-settings [current]="current" (updated)="environment.set($event)" />
        </div>
      }
    </div>
  `,
})
export class EnvironmentPage {
  private readonly api = inject(WorkspaceApi);
  protected readonly shell = inject(ShellContext);
  protected readonly tab = signal('applications');
  protected readonly tabs: readonly Tab[] = [
    { id: 'applications', label: 'Resources', icon: 'apps' },
    { id: 'secrets', label: 'Variables and secrets', icon: 'key' },
    { id: 'access', label: 'Members', icon: 'users' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
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

  protected readonly notice = inject(Notice);
  private readonly crumbs = inject(PageCrumbs);

  constructor() {
    effect(() => {
      const name = this.environment()?.name;
      if (name)
        this.crumbs.set([
          {
            label: this.projectName(),
            raw: true,
            link: ['/orgs', this.organizationId(), 'projects', this.projectId()],
          },
          { label: name, raw: true },
        ]);
    });
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
