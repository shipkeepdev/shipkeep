import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { MutationRunner } from '../identity/mutation-runner';
import { SessionStore } from '../identity/session-store';
import { T } from '../ui/i18n';

import { Collection } from './collection';
import { recoverOnEdit } from './form-recovery';
import { required, slug } from './validators';
import { WorkspaceApi } from './workspace-api';

/** Organizations of the signed-in account, and creating one (password re-authentication). */
@Component({
  selector: 'sk-organizations-page',
  imports: [ReactiveFormsModule, RouterLink, T],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-[18px]">
      <div>
        <h1 id="organizations-title" class="page-title">{{ 'Organizations' | t }}</h1>
        <div class="page-sub">
          {{ 'Each organization owns its servers, projects and members.' | t }}
        </div>
      </div>
      @if (session.state() === 'anonymous') {
        <p class="text-[13.5px] text-fg3">{{ 'Sign in to see your organizations.' | t }}</p>
        <div>
          <a class="btn btn-primary" routerLink="/auth/login">{{ 'Sign in' | t }}</a>
        </div>
      } @else {
        @switch (list.state()) {
          @case ('loading') {
            <p role="status" class="text-[13px] text-mute2">{{ 'Loading…' | t }}</p>
          }
          @case ('failed') {
            <div class="alert" role="alert">{{ list.problem() | t }}</div>
            <div>
              <button class="btn btn-sm" type="button" (click)="list.refresh()">
                {{ 'Retry' | t }}
              </button>
            </div>
          }
          @default {
            @if (list.items().length) {
              <ul
                class="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-3 p-0"
                [attr.aria-label]="'Your organizations' | t"
              >
                @for (organization of list.items(); track organization.id) {
                  <li>
                    <a
                      [routerLink]="['/orgs', organization.id]"
                      class="flex items-center gap-3 rounded-2xl border border-line bg-black p-4 transition-[border-color] duration-200 hover:border-[#3A3A40]"
                    >
                      <span
                        aria-hidden="true"
                        class="grid size-[38px] shrink-0 place-items-center rounded-[10px] bg-fg text-[13px] font-bold text-[#0b0b0d]"
                        >{{ initials(organization.name) }}</span
                      >
                      <span class="min-w-0">
                        <span class="block truncate text-[13.5px] font-medium">{{
                          organization.name
                        }}</span>
                        <span class="block font-mono text-[11.5px] text-dim" aria-hidden="true">{{
                          organization.slug
                        }}</span>
                      </span>
                    </a>
                  </li>
                }
              </ul>
            } @else {
              <p class="rounded-2xl border border-dashed border-ctl p-6 text-[13px] text-mute2">
                {{ 'You are not a member of any organization yet.' | t }}
              </p>
            }
          }
        }
        <section
          class="card flex max-w-[640px] flex-col gap-3 p-5"
          aria-labelledby="create-organization-title"
        >
          <h2 id="create-organization-title" class="text-[15px] font-medium">
            {{ 'Create an organization' | t }}
          </h2>
          @if (runner.problem(); as problem) {
            <div class="alert" role="alert">{{ problem | t }}</div>
          }
          <form [formGroup]="form" (ngSubmit)="create()" class="flex flex-col gap-3">
            <div class="grid grid-cols-2 gap-2.5 max-sm:grid-cols-1">
              <div class="flex flex-col gap-1.5">
                <label for="organization-name" class="text-[12px] text-fg3">{{ 'Name' | t }}</label>
                <input
                  id="organization-name"
                  class="input"
                  formControlName="name"
                  maxlength="80"
                  autocomplete="organization"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <label for="organization-slug" class="text-[12px] text-fg3">{{
                  'Identifier' | t
                }}</label>
                <input
                  id="organization-slug"
                  class="input font-mono"
                  formControlName="slug"
                  maxlength="40"
                  autocomplete="off"
                  spellcheck="false"
                  aria-describedby="organization-slug-hint"
                />
                <p id="organization-slug-hint" class="text-[11.5px] text-dim">
                  {{ 'Lowercase letters, digits and hyphens. Used in URLs.' | t }}
                </p>
              </div>
            </div>
            <div class="flex max-w-[320px] flex-col gap-1.5">
              <label for="organization-password" class="text-[12px] text-fg3">{{
                'Your password' | t
              }}</label>
              <input
                id="organization-password"
                class="input"
                formControlName="password"
                type="password"
                autocomplete="current-password"
                aria-describedby="organization-password-hint"
              />
              <p id="organization-password-hint" class="text-[11.5px] text-dim">
                {{ 'Creating an organization makes you its owner, so it needs your password.' | t }}
              </p>
            </div>
            <div>
              <button
                class="btn btn-primary"
                type="submit"
                [disabled]="runner.busy() || !!runner.cooldown() || form.invalid"
              >
                {{ (runner.busy() ? 'Creating…' : 'Create organization') | t }}
              </button>
            </div>
          </form>
        </section>
      }
    </div>
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
    recoverOnEdit(this.form, this.runner);
    void this.list.refresh();
  }

  protected initials(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word.at(0)?.toUpperCase() ?? '')
      .join('');
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
