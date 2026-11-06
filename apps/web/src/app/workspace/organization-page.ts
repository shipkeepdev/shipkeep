import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { IdentityRequestError } from '../identity/identity-api';
import { MutationRunner } from '../identity/mutation-runner';

import { Collection } from './collection';
import { required, slug } from './validators';
import { type Organization, type Project, WorkspaceApi } from './workspace-api';

/** One organization: its projects, and creating a project (organization admins). */
@Component({
  selector: 'sk-organization-page',
  imports: [ReactiveFormsModule, RouterLink],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav aria-label="Breadcrumb" class="mb-4 text-sm"><a routerLink="/orgs">Organizations</a></nav>
    <section class="max-w-3xl" aria-labelledby="organization-title">
      <h1 id="organization-title">{{ organization()?.name ?? 'Organization' }}</h1>
      @if (missing()) {
        <div class="feedback" role="alert">
          <p>{{ missing() }}</p>
        </div>
      } @else {
        <p class="page-intro">
          Projects group the environments of one product.
          <a [routerLink]="['/orgs', organizationId(), 'nodes']">Manage servers</a>
        </p>
        <h2>Projects</h2>
        @switch (projects.state()) {
          @case ('loading') {
            <p role="status" class="text-muted">Loading projects…</p>
          }
          @case ('failed') {
            <div class="feedback" role="alert">
              <p>{{ projects.problem() }}</p>
            </div>
          }
          @default {
            @if (projects.items().length) {
              <ul class="mb-8 divide-y divide-line border-y border-line" aria-label="Projects">
                @for (project of projects.items(); track project.id) {
                  <li class="py-3">
                    <a [routerLink]="['/orgs', organizationId(), 'projects', project.id]">{{
                      project.name
                    }}</a>
                    <span class="ml-2 text-sm text-muted">{{ project.slug }}</span>
                  </li>
                }
              </ul>
            } @else {
              <p class="mb-8 border-y border-line py-6 text-muted">No projects yet.</p>
            }
          }
        }
        <section aria-labelledby="create-project-title" class="border-t border-line pt-6">
          <h2 id="create-project-title">Create a project</h2>
          @if (runner.problem(); as problem) {
            <div class="feedback" role="alert">
              <p>{{ problem }}</p>
            </div>
          }
          <form [formGroup]="form" (ngSubmit)="create()" class="grid gap-4">
            <div>
              <label for="project-name">Name</label>
              <input id="project-name" formControlName="name" maxlength="80" autocomplete="off" />
            </div>
            <div>
              <label for="project-slug">Slug</label>
              <input
                id="project-slug"
                formControlName="slug"
                maxlength="40"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
            <div>
              <button class="button" type="submit" [disabled]="runner.busy() || form.invalid">
                {{ runner.busy() ? 'Creating…' : 'Create project' }}
              </button>
            </div>
          </form>
        </section>
      }
    </section>
  `,
})
export class OrganizationPage {
  private readonly api = inject(WorkspaceApi);
  protected readonly runner = inject(MutationRunner);
  readonly organizationId = input.required<string>();
  protected readonly organization = signal<Organization | null>(null);
  protected readonly missing = signal<string | null>(null);
  protected readonly projects = new Collection<Project>(() =>
    this.api.projects(this.organizationId()),
  );
  protected readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [required] }),
    slug: new FormControl('', {
      nonNullable: true,
      validators: [required, slug],
    }),
  });

  constructor() {
    effect(() => {
      const id = this.organizationId();
      void this.load(id);
    });
  }

  private async load(id: string): Promise<void> {
    this.missing.set(null);
    try {
      this.organization.set(await this.api.organization(id));
      await this.projects.refresh();
    } catch (error: unknown) {
      this.organization.set(null);
      this.missing.set(
        error instanceof IdentityRequestError
          ? error.message
          : 'This organization could not be loaded.',
      );
    }
  }

  protected async create(): Promise<void> {
    const value = this.form.getRawValue();
    const body = {
      name: value.name.trim(),
      slug: value.slug.trim(),
      gitWriteMode: 'commit' as const,
    };
    const outcome = await this.runner.run(body, (key) =>
      this.api.createProject(this.organizationId(), body, key),
    );
    if (!outcome.ok) return;
    this.form.reset();
    await this.projects.refresh();
  }
}
