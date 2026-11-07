import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { IdentityRequestError } from '../identity/identity-api';
import { MutationRunner } from '../identity/mutation-runner';

import { Collection } from './collection';
import { recoverOnEdit } from './form-recovery';
import { OrganizationOverview } from './organization-overview';
import { OrganizationSettings } from './organization-settings';
import { required, slug } from './validators';
import { type Organization, type Project, WorkspaceApi } from './workspace-api';

/** One organization: its projects, and creating a project (organization admins). */
@Component({
  selector: 'sk-organization-page',
  imports: [ReactiveFormsModule, RouterLink, OrganizationOverview, OrganizationSettings],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="organization-title">
      <div class="page-header">
        <div class="min-w-0">
          <h1 id="organization-title">{{ organization()?.name ?? 'Organization' }}</h1>
          <p class="text-[13.5px] text-muted">Overview of what runs in this organization.</p>
        </div>
      </div>
      @if (missing()) {
        <div class="feedback" role="alert">
          <p>{{ missing() }}</p>
        </div>
      } @else {
        <sk-organization-overview [organizationId]="organizationId()" />
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
              <ul class="mb-6 divide-y divide-line border-y border-line" aria-label="Projects">
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
              <p class="mb-6 border-y border-line py-6 text-muted">No projects yet.</p>
            }
          }
        }
        <details class="disclosure">
          <summary>Create a project</summary>
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
              <button
                class="button"
                type="submit"
                [disabled]="runner.busy() || !!runner.cooldown() || form.invalid"
              >
                {{ runner.busy() ? 'Creating…' : 'Create project' }}
              </button>
            </div>
          </form>
        </details>
        @if (organization(); as current) {
          <details class="disclosure">
            <summary>Organization settings</summary>
            <sk-organization-settings [current]="current" (updated)="organization.set($event)" />
          </details>
        }
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
    recoverOnEdit(this.form, this.runner);
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
