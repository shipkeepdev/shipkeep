import {
  ChangeDetectionStrategy,
  Component,
  effect,
  type ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { BindingsPanel } from '../access/bindings-panel';
import { ProjectTokensPanel } from '../access/project-tokens-panel';
import { IdentityRequestError } from '../identity/identity-api';
import { MutationRunner } from '../identity/mutation-runner';
import { Icon } from '../shell/icon';
import { ShellContext } from '../shell/shell-context';
import { T } from '../ui/i18n';
import { PageCrumbs } from '../dashboard/page-crumbs';
import { type Tab, Tabs } from '../shell/tabs';

import { Collection } from './collection';
import { recoverOnEdit } from './form-recovery';
import { ProjectSettings } from './project-settings';
import { required } from './validators';
import { type Environment, type Project, WorkspaceApi } from './workspace-api';

/** One project: its environments, and creating one (protected by default, SPEC 7). */
@Component({
  selector: 'sk-project-page',
  imports: [
    BindingsPanel,
    Icon,
    ProjectSettings,
    ProjectTokensPanel,
    ReactiveFormsModule,
    RouterLink,
    T,
    Tabs,
  ],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page gap-[18px]">
      <div class="page-head">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-3">
            <h1 class="page-title">{{ project()?.name ?? '…' }}</h1>
            <span class="pill">{{
              '{n} environments' | t: { n: environments.items().length }
            }}</span>
          </div>
          <div class="mt-1.5 max-w-[720px] text-[13px] text-mute2">
            {{
              'A project groups the environments of a client or a product. Each environment has its own resources, variables and rights.'
                | t
            }}
          </div>
        </div>
        <div class="flex flex-wrap gap-2.5">
          <button type="button" class="btn" (click)="open('settings')">
            <sk-icon name="settings" />{{ 'Settings' | t }}
          </button>
          <button type="button" class="btn btn-primary" (click)="newEnvironment()">
            <sk-icon name="plus" />{{ 'New environment' | t }}
          </button>
        </div>
      </div>
      @if (missing()) {
        <div class="alert" role="alert">{{ missing() | t }}</div>
      } @else {
        <sk-tabs label="Project sections" [tabs]="tabs" [(active)]="tab" />
        <div
          id="panel-environments"
          role="tabpanel"
          aria-labelledby="tab-environments"
          class="flex flex-col gap-4"
          [hidden]="tab() !== 'environments'"
        >
          @switch (environments.state()) {
            @case ('loading') {
              <p role="status" class="text-[13px] text-mute2">{{ 'Loading…' | t }}</p>
            }
            @case ('failed') {
              <div class="alert" role="alert">{{ environments.problem() | t }}</div>
            }
            @default {
              <div class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3">
                @for (environment of environments.items(); track environment.id) {
                  <a
                    [routerLink]="[
                      '/orgs',
                      organizationId(),
                      'projects',
                      projectId(),
                      'environments',
                      environment.id,
                    ]"
                    class="flex flex-col gap-3 rounded-2xl border bg-black p-4 transition-[border-color] duration-200 hover:border-[#3A3A40]"
                    [style.border-color]="
                      environment.protected ? 'rgba(255,92,92,0.35)' : '#1C1C1E'
                    "
                  >
                    <div class="flex items-center gap-3">
                      <span
                        class="grid size-[38px] shrink-0 place-items-center rounded-[10px] border border-line"
                      >
                        <sk-icon
                          [name]="
                            environment.protected
                              ? 'shield-check'
                              : environment.kind === 'preview'
                                ? 'git-pull-request'
                                : 'flask'
                          "
                          class="text-[19px] text-fg2"
                        />
                      </span>
                      <div class="min-w-0 flex-1">
                        <div class="text-[13.5px] font-medium">{{ environment.name }}</div>
                        <div class="mt-0.5 text-[11.5px] text-dim">
                          {{
                            (environment.protected
                              ? 'protected · admins deploy and set secrets'
                              : environment.kind === 'preview'
                                ? 'one copy per pull request'
                                : 'standard'
                            ) | t
                          }}
                        </div>
                      </div>
                    </div>
                    <div
                      class="flex flex-wrap gap-3.5 border-t border-line2 pt-3 text-[11.5px] text-mute"
                    >
                      <span class="flex items-center gap-[5px]"
                        ><sk-icon name="heartbeat" class="text-[13px]" />{{
                          (environment.failoverPolicy === 'none'
                            ? 'no failover policy'
                            : 'restore from backup'
                          ) | t
                        }}</span
                      >
                      <span class="flex items-center gap-[5px]"
                        ><sk-icon name="clock" class="text-[13px]" />{{
                          environment.createdAt.slice(0, 10)
                        }}</span
                      >
                    </div>
                  </a>
                } @empty {
                  <p class="text-[13px] text-mute2">{{ 'No environment yet.' | t }}</p>
                }
              </div>
            }
          }
          <section
            #createSection
            class="card flex max-w-[640px] flex-col gap-3 p-5"
            aria-labelledby="create-environment-title"
          >
            <h2 id="create-environment-title" class="text-[15px] font-medium">
              {{ 'New environment' | t }}
            </h2>
            @if (runner.problem(); as problem) {
              <div class="alert" role="alert">{{ problem | t }}</div>
            }
            <form [formGroup]="form" (ngSubmit)="create()" class="flex flex-col gap-3">
              <div class="flex flex-col gap-1.5">
                <label for="environment-name" class="text-[12px] text-fg3">{{ 'Name' | t }}</label>
                <input
                  id="environment-name"
                  class="input font-mono"
                  formControlName="name"
                  maxlength="40"
                  autocomplete="off"
                  placeholder="production"
                />
              </div>
              <label
                class="flex items-center gap-2.5 text-[12.5px] text-fg3"
                for="environment-protected"
              >
                <input
                  id="environment-protected"
                  type="checkbox"
                  class="size-4 accent-[#f2f2f3]"
                  formControlName="protected"
                />
                {{ 'Protected: only administrators deploy and set secrets' | t }}
              </label>
              <div>
                <button
                  class="btn btn-primary"
                  type="submit"
                  [disabled]="runner.busy() || !!runner.cooldown() || form.invalid"
                >
                  {{ (runner.busy() ? 'Creating…' : 'Create environment') | t }}
                </button>
              </div>
            </form>
          </section>
        </div>
        @if (project(); as current) {
          <div
            id="panel-access"
            role="tabpanel"
            aria-labelledby="tab-access"
            class="legacy-form"
            [hidden]="tab() !== 'access'"
          >
            <sk-bindings-panel
              [scope]="{ organizationId: organizationId(), projectId: projectId() }"
            />
          </div>
          <div
            id="panel-tokens"
            role="tabpanel"
            aria-labelledby="tab-tokens"
            class="legacy-form"
            [hidden]="tab() !== 'tokens'"
          >
            <sk-project-tokens-panel
              [organizationId]="organizationId()"
              [projectId]="projectId()"
            />
          </div>
          <div
            id="panel-settings"
            role="tabpanel"
            aria-labelledby="tab-settings"
            class="legacy-form"
            [hidden]="tab() !== 'settings'"
          >
            <sk-project-settings [current]="current" (updated)="project.set($event)" />
          </div>
        }
      }
    </div>
  `,
})
export class ProjectPage {
  private readonly api = inject(WorkspaceApi);
  protected readonly runner = inject(MutationRunner);
  protected readonly shell = inject(ShellContext);
  protected readonly tab = signal('environments');
  protected readonly tabs: readonly Tab[] = [
    { id: 'environments', label: 'Environments', icon: 'stack-2' },
    { id: 'access', label: 'Members', icon: 'users' },
    { id: 'tokens', label: 'API tokens', icon: 'key' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ];
  readonly organizationId = input.required<string>();
  readonly projectId = input.required<string>();
  protected readonly project = signal<Project | null>(null);
  protected readonly missing = signal<string | null>(null);
  protected readonly environments = new Collection<Environment>(() =>
    this.api.environments(this.organizationId(), this.projectId()),
  );
  protected readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [required] }),
    protected: new FormControl(true, { nonNullable: true }),
  });

  private readonly crumbs = inject(PageCrumbs);
  private readonly createSection = viewChild<ElementRef<HTMLElement>>('createSection');

  constructor() {
    recoverOnEdit(this.form, this.runner);
    effect(() => {
      const name = this.project()?.name;
      if (name)
        this.crumbs.set([
          { label: 'Projects', link: ['/orgs', this.organizationId(), 'projects'] },
          { label: name, raw: true },
        ]);
    });
    effect(() => {
      void this.load(this.organizationId(), this.projectId());
    });
  }

  protected open(tab: string): void {
    this.tab.set(tab);
  }

  protected newEnvironment(): void {
    this.tab.set('environments');
    setTimeout(() => {
      this.createSection()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.createSection()?.nativeElement.querySelector('input')?.focus();
    });
  }

  private async load(organizationId: string, projectId: string): Promise<void> {
    this.missing.set(null);
    try {
      this.project.set(await this.api.project(organizationId, projectId));
      await this.environments.refresh();
    } catch (error: unknown) {
      this.project.set(null);
      this.missing.set(
        error instanceof IdentityRequestError ? error.message : 'This project could not be loaded.',
      );
    }
  }

  protected async create(): Promise<void> {
    const value = this.form.getRawValue();
    const body = {
      name: value.name.trim(),
      protected: value.protected,
      kind: 'standard' as const,
      failoverPolicy: 'none' as const,
    };
    const outcome = await this.runner.run(body, (key) =>
      this.api.createEnvironment(this.organizationId(), this.projectId(), body, key),
    );
    if (!outcome.ok) return;
    this.form.reset();
    await this.environments.refresh();
  }
}
