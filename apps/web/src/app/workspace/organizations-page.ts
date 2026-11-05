import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { MutationRunner } from '../identity/mutation-runner';
import { SessionStore } from '../identity/session-store';

import { Collection } from './collection';
import { required, slug } from './validators';
import { WorkspaceApi } from './workspace-api';

/** Organizations of the signed-in account, and creating one (password re-authentication). */
@Component({
  selector: 'sk-organizations-page',
  imports: [ReactiveFormsModule, RouterLink],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="max-w-2xl" aria-labelledby="organizations-title">
      <h1 id="organizations-title">Organizations</h1>
      @if (session.state() === 'anonymous') {
        <p class="mb-6">Sign in to see your organizations.</p>
        <a class="button" routerLink="/auth/login">Sign in</a>
      } @else {
        <p class="page-intro">Each organization owns its servers, projects and members.</p>
        @switch (list.state()) {
          @case ('loading') {
            <p role="status" class="text-muted">Loading organizations…</p>
          }
          @case ('failed') {
            <div class="feedback" role="alert">
              <p>{{ list.problem() }}</p>
            </div>
            <button class="button button-secondary" type="button" (click)="list.refresh()">
              Retry
            </button>
          }
          @default {
            @if (list.items().length) {
              <ul
                class="mb-8 divide-y divide-line border-y border-line"
                aria-label="Your organizations"
              >
                @for (organization of list.items(); track organization.id) {
                  <li class="py-3">
                    <a [routerLink]="['/orgs', organization.id]">{{ organization.name }}</a>
                    <span class="ml-2 text-sm text-muted">{{ organization.slug }}</span>
                  </li>
                }
              </ul>
            } @else {
              <p class="mb-8 border-y border-line py-6 text-muted">
                You are not a member of any organization yet.
              </p>
            }
          }
        }
        <section aria-labelledby="create-organization-title" class="border-t border-line pt-6">
          <h2 id="create-organization-title">Create an organization</h2>
          @if (runner.problem(); as problem) {
            <div class="feedback" role="alert">
              <p>{{ problem }}</p>
            </div>
          }
          <form [formGroup]="form" (ngSubmit)="create()" class="grid gap-4">
            <div>
              <label for="organization-name">Name</label>
              <input
                id="organization-name"
                formControlName="name"
                maxlength="80"
                autocomplete="organization"
              />
            </div>
            <div>
              <label for="organization-slug">Slug</label>
              <input
                id="organization-slug"
                formControlName="slug"
                maxlength="40"
                autocomplete="off"
                spellcheck="false"
              />
              <p class="hint">Lowercase letters, digits and hyphens. Used in URLs.</p>
            </div>
            <div>
              <label for="organization-password">Your password</label>
              <input
                id="organization-password"
                formControlName="password"
                type="password"
                autocomplete="current-password"
              />
              <p class="hint">
                Creating an organization makes you its owner, so it needs your password.
              </p>
            </div>
            <div>
              <button class="button" type="submit" [disabled]="runner.busy() || form.invalid">
                {{ runner.busy() ? 'Creating…' : 'Create organization' }}
              </button>
            </div>
          </form>
        </section>
      }
    </section>
  `,
})
export class OrganizationsPage {
  private readonly api = inject(WorkspaceApi);
  private readonly router = inject(Router);
  protected readonly session = inject(SessionStore);
  protected readonly runner = inject(MutationRunner);
  protected readonly list = new Collection(() => this.api.organizations());
  protected readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [required] }),
    slug: new FormControl('', {
      nonNullable: true,
      validators: [required, slug],
    }),
    password: new FormControl('', { nonNullable: true, validators: [required] }),
  });

  constructor() {
    void this.list.refresh();
  }

  protected async create(): Promise<void> {
    const value = this.form.getRawValue();
    const body = { name: value.name.trim(), slug: value.slug.trim(), password: value.password };
    const outcome = await this.runner.run(body, (key) => this.api.createOrganization(body, key));
    this.form.controls.password.reset();
    if (!outcome.ok) return;
    // Creation rotates the session; keep only its public fields.
    this.session.accept(outcome.value.session);
    await this.router.navigate(['/orgs', outcome.value.organization.id]);
  }
}
