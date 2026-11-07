import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { BindingsPanel } from '../access/bindings-panel';
import { ProjectTokensPanel } from '../access/project-tokens-panel';
import { IdentityRequestError } from '../identity/identity-api';
import { MutationRunner } from '../identity/mutation-runner';

import { Collection } from './collection';
import { recoverOnEdit } from './form-recovery';
import { ProjectSettings } from './project-settings';
import { required } from './validators';
import { type Environment, type Project, WorkspaceApi } from './workspace-api';

/** One project: its environments, and creating one (protected by default, SPEC 7). */
@Component({
  selector: 'sk-project-page',
  imports: [ReactiveFormsModule, RouterLink, ProjectSettings, BindingsPanel, ProjectTokensPanel],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav aria-label="Breadcrumb" class="mb-4 text-sm">
      <a routerLink="/orgs">Organizations</a> /
      <a [routerLink]="['/orgs', organizationId()]">Organization</a>
    </nav>
    <section class="max-w-3xl" aria-labelledby="project-title">
      <h1 id="project-title">{{ project()?.name ?? 'Project' }}</h1>
      @if (missing()) {
        <div class="feedback" role="alert">
          <p>{{ missing() }}</p>
        </div>
      } @else {
        <h2>Environments</h2>
        @switch (environments.state()) {
          @case ('loading') {
            <p role="status" class="text-muted">Loading environments…</p>
          }
          @case ('failed') {
            <div class="feedback" role="alert">
              <p>{{ environments.problem() }}</p>
            </div>
          }
          @default {
            @if (environments.items().length) {
              <ul class="mb-8 divide-y divide-line border-y border-line" aria-label="Environments">
                @for (environment of environments.items(); track environment.id) {
                  <li class="py-3">
                    <a
                      [routerLink]="[
                        '/orgs',
                        organizationId(),
                        'projects',
                        projectId(),
                        'environments',
                        environment.id,
                      ]"
                      >{{ environment.name }}</a
                    >
                    @if (environment.protected) {
                      <span class="ml-2 text-sm text-muted">protected</span>
                    }
                  </li>
                }
              </ul>
            } @else {
              <p class="mb-8 border-y border-line py-6 text-muted">No environments yet.</p>
            }
          }
        }
        <section aria-labelledby="create-environment-title" class="border-t border-line pt-6">
          <h2 id="create-environment-title">Create an environment</h2>
          @if (runner.problem(); as problem) {
            <div class="feedback" role="alert">
              <p>{{ problem }}</p>
            </div>
          }
          <form [formGroup]="form" (ngSubmit)="create()" class="grid gap-4">
            <div>
              <label for="environment-name">Name</label>
              <input
                id="environment-name"
                formControlName="name"
                maxlength="40"
                autocomplete="off"
                placeholder="production"
              />
            </div>
            <div class="flex items-center gap-2">
              <input id="environment-protected" type="checkbox" formControlName="protected" />
              <label for="environment-protected" class="mb-0"
                >Protected: only administrators deploy and set secrets</label
              >
            </div>
            <div>
              <button class="button" type="submit" [disabled]="runner.busy() || form.invalid">
                {{ runner.busy() ? 'Creating…' : 'Create environment' }}
              </button>
            </div>
          </form>
        </section>
        @if (project(); as current) {
          <sk-project-settings [current]="current" (updated)="project.set($event)" />
          <sk-bindings-panel
            [scope]="{ organizationId: organizationId(), projectId: projectId() }"
          />
          <sk-project-tokens-panel [organizationId]="organizationId()" [projectId]="projectId()" />
        }
      }
    </section>
  `,
})
export class ProjectPage {
  private readonly api = inject(WorkspaceApi);
  protected readonly runner = inject(MutationRunner);
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

  constructor() {
    recoverOnEdit(this.form, this.runner);
    effect(() => {
      void this.load(this.organizationId(), this.projectId());
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
