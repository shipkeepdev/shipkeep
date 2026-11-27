import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { DOCUMENT } from '@angular/common';

import { GREEN } from '../dashboard/format';
import { MutationRunner } from '../identity/mutation-runner';
import { Icon } from '../shell/icon';
import { ShellContext } from '../shell/shell-context';
import { Brand } from '../ui/brand';
import { T } from '../ui/i18n';

import { type GithubApp, GithubApi, type GithubRepositories } from './github-api';

/**
 * 16 Integrations, live for GitHub (ADR 0031): the organization's own GitHub App, created by an
 * owner through GitHub's manifest flow, and the repositories its installations reach. Other
 * sources are planned and said so, never shown as sample data.
 */
@Component({
  selector: 'sk-integrations-page',
  imports: [Brand, Icon, ReactiveFormsModule, T],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-[18px]">
      <div class="page-head">
        <div>
          <h1 class="page-title">{{ 'Integrations' | t }}</h1>
          <div class="page-sub">
            {{ 'The Git sources the organization deploys from.' | t }}
          </div>
        </div>
      </div>

      <section class="flex flex-col gap-3" aria-labelledby="github-title">
        <div>
          <h2 id="github-title" class="sec-title flex items-center gap-2">
            <sk-brand name="github" class="size-4" />GitHub
          </h2>
          <p class="sec-desc text-pretty">
            {{
              'A private GitHub App of this organization: it sends signed pushes and reads only the repositories you install it on.'
                | t
            }}
          </p>
        </div>

        @if (unread()) {
          <div class="alert flex-wrap items-center justify-between" role="alert">
            <span>{{ 'The GitHub integration could not be read.' | t }}</span>
            <button type="button" class="btn btn-sm" (click)="load()">{{ 'Try again' | t }}</button>
          </div>
        }

        @if (loaded()) {
          @if (app(); as connected) {
            <div class="card flex flex-col gap-4 p-5">
              <div class="flex flex-wrap items-center gap-3.5">
                <span
                  class="grid size-10 shrink-0 place-items-center rounded-[11px] border border-ctl"
                  ><sk-brand name="github" class="size-5 text-fg"
                /></span>
                <div class="min-w-0 flex-[1_1_220px]">
                  <div class="flex flex-wrap items-center gap-2 text-[14px] font-medium">
                    {{ connected.name }}
                    <span class="pill"
                      ><span class="dot" [style.background]="green"></span
                      >{{ 'Connected' | t }}</span
                    >
                  </div>
                  <div class="mt-[3px] text-[12.5px] text-mute2">
                    {{ 'On the GitHub account {owner}' | t: { owner: connected.ownerLogin } }}
                  </div>
                </div>
                <div class="flex flex-wrap gap-2">
                  <a class="btn btn-sm" [href]="installUrl(connected)" rel="noopener"
                    ><sk-icon name="plus" />{{ 'Install on repositories' | t }}</a
                  >
                  <a class="btn btn-sm" [href]="connected.url" rel="noopener"
                    ><sk-icon name="external-link" />{{ 'Open on GitHub' | t }}</a
                  >
                </div>
              </div>

              <div class="border-t border-line2 pt-4">
                <h3 class="mb-2 text-[13px] font-medium text-fg2">{{ 'Repositories' | t }}</h3>
                @if (reposUnread()) {
                  <div class="alert flex-wrap items-center justify-between" role="alert">
                    <span>{{ 'GitHub could not be reached. Try again in a moment.' | t }}</span>
                    <button type="button" class="btn btn-sm" (click)="loadRepositories()">
                      {{ 'Try again' | t }}
                    </button>
                  </div>
                } @else if (repositories(); as listing) {
                  @if (listing.unreachable.length) {
                    <div class="note mb-2 text-[12px] text-mute2">
                      <sk-icon name="alert-triangle" class="text-[15px]" />
                      <span>{{
                        'GitHub did not answer for {n} installation(s), removed or suspended there.'
                          | t: { n: listing.unreachable.length }
                      }}</span>
                    </div>
                  }
                  @if (listing.repositories.length) {
                    <ul class="card m-0 flex list-none flex-col p-0">
                      @for (r of listing.repositories; track r.id) {
                        <li
                          class="flex flex-wrap items-center justify-between gap-3 border-t border-line2 px-[18px] py-3 first:border-t-0"
                        >
                          <div class="min-w-0">
                            <div class="truncate font-mono text-[12.5px] text-fg">
                              {{ r.fullName }}
                            </div>
                            <div class="mt-0.5 text-[11.5px] text-dim">
                              {{ 'default branch {branch}' | t: { branch: r.defaultBranch } }}
                            </div>
                          </div>
                          <span class="pill text-[11.5px]">{{
                            (r.private ? 'private' : 'public') | t
                          }}</span>
                        </li>
                      }
                    </ul>
                    @if (listing.truncated) {
                      <p class="mt-2 text-[12px] text-mute2">
                        {{ 'Only the first 500 repositories are listed.' | t }}
                      </p>
                    }
                  } @else {
                    <div
                      class="rounded-2xl border border-dashed border-ctl p-6 text-center text-[13px] text-mute2"
                    >
                      {{
                        'No repository yet: install the App on the repositories Shipkeep may deploy from.'
                          | t
                      }}
                    </div>
                  }
                } @else {
                  <p class="text-[12.5px] text-mute2">{{ 'Reading the repositories…' | t }}</p>
                }
              </div>
            </div>
          } @else {
            <div class="card flex flex-col gap-4 p-5">
              <div class="flex flex-wrap items-center gap-3.5">
                <span
                  class="grid size-10 shrink-0 place-items-center rounded-[11px] border border-ctl"
                  ><sk-brand name="github" class="size-5 text-fg"
                /></span>
                <div class="min-w-0 flex-[1_1_220px]">
                  <div class="text-[14px] font-medium">{{ 'GitHub App' | t }}</div>
                  <div class="mt-[3px] text-[12.5px] leading-[1.45] text-mute2">
                    {{
                      'GitHub creates it in about a minute, then you choose the repositories it may read.'
                        | t
                    }}
                  </div>
                </div>
              </div>
              @if (owner()) {
                @if (runner.problem(); as problem) {
                  <div class="alert" role="alert">{{ problem | t }}</div>
                }
                <form [formGroup]="form" (ngSubmit)="create()" class="flex flex-col gap-3">
                  <fieldset class="m-0 flex flex-col gap-2 border-0 p-0">
                    <legend class="mb-1 text-[12.5px] text-mute2">
                      {{ 'Where GitHub creates the App' | t }}
                    </legend>
                    <label class="flex items-center gap-2 text-[13px]">
                      <input type="radio" formControlName="owner" value="user" />
                      {{ 'My GitHub account' | t }}
                    </label>
                    <label class="flex items-center gap-2 text-[13px]">
                      <input type="radio" formControlName="owner" value="organization" />
                      {{ 'A GitHub organization' | t }}
                    </label>
                  </fieldset>
                  @if (form.controls.owner.value === 'organization') {
                    <div class="flex flex-col gap-1">
                      <label for="github-organization" class="text-[12.5px] text-mute2">{{
                        'GitHub organization' | t
                      }}</label>
                      <input
                        id="github-organization"
                        class="input max-w-xs font-mono text-[12.5px]"
                        formControlName="githubOrganization"
                        autocomplete="off"
                        spellcheck="false"
                        maxlength="39"
                      />
                    </div>
                  }
                  <div>
                    <button
                      class="btn btn-primary"
                      type="submit"
                      [disabled]="runner.busy() || !!runner.cooldown()"
                    >
                      {{ (runner.busy() ? 'Opening GitHub…' : 'Create the GitHub App') | t
                      }}<sk-icon name="arrow-right" />
                    </button>
                  </div>
                </form>
              } @else {
                <p class="text-[12.5px] text-mute2">
                  {{ 'An owner of the organization creates it.' | t }}
                </p>
              }
            </div>
          }
        } @else if (!unread()) {
          <p class="text-[12.5px] text-mute2">{{ 'Loading…' | t }}</p>
        }
      </section>

      <div class="note text-[12px] text-mute2">
        <sk-icon name="info-circle" class="text-[15px]" />
        <span>{{ 'GitLab, Gitea and Bitbucket are planned.' | t }}</span>
      </div>
    </div>
  `,
})
export class IntegrationsPage {
  private readonly api = inject(GithubApi);
  private readonly shell = inject(ShellContext);
  private readonly document = inject(DOCUMENT);
  protected readonly runner = inject(MutationRunner);
  protected readonly green = GREEN;

  readonly organizationId = input.required<string>();

  protected readonly app = signal<GithubApp | null>(null);
  protected readonly loaded = signal(false);
  protected readonly unread = signal(false);
  protected readonly repositories = signal<GithubRepositories | null>(null);
  protected readonly reposUnread = signal(false);
  protected readonly owner = computed(() => this.shell.role() === 'owner');
  protected readonly form = new FormGroup({
    owner: new FormControl<'user' | 'organization'>('user', { nonNullable: true }),
    githubOrganization: new FormControl('', { nonNullable: true }),
  });
  private revision = 0;

  constructor() {
    effect(() => {
      this.organizationId();
      untracked(() => {
        this.app.set(null);
        this.loaded.set(false);
        this.repositories.set(null);
        void this.load();
      });
    });
  }

  /** Reads the App, then its repositories; a stale answer is dropped. */
  async load(): Promise<void> {
    const revision = ++this.revision;
    const organizationId = this.organizationId();
    try {
      const app = await this.api.app(organizationId);
      if (revision !== this.revision) return;
      this.app.set(app);
      this.loaded.set(true);
      this.unread.set(false);
      if (app) await this.loadRepositories();
    } catch {
      if (revision === this.revision) this.unread.set(true);
    }
  }

  async loadRepositories(): Promise<void> {
    const revision = this.revision;
    try {
      const listing = await this.api.repositories(this.organizationId());
      if (revision !== this.revision) return;
      this.repositories.set(listing);
      this.reposUnread.set(false);
    } catch {
      if (revision === this.revision) this.reposUnread.set(true);
    }
  }

  protected installUrl(app: GithubApp): string {
    return `${app.url}/installations/new`;
  }

  /**
   * Asks the control plane for the manifest, then posts it to GitHub, which creates the App and
   * sends the owner back to the integrations' GitHub page. The form is built here because GitHub
   * reads the manifest from a form field, never from a URL.
   */
  protected async create(): Promise<void> {
    const { owner, githubOrganization } = this.form.getRawValue();
    const body =
      owner === 'organization'
        ? { owner, githubOrganization: githubOrganization.trim() }
        : { owner };
    const outcome = await this.runner.run(body, () =>
      this.api.startManifest(this.organizationId(), body),
    );
    if (!outcome.ok) return;
    const target = new URL(outcome.value.url);
    // Only GitHub: the form leaves the control plane, and the CSP allows no other target.
    if (target.origin !== 'https://github.com') return;
    const form = this.document.createElement('form');
    form.method = 'post';
    form.action = target.href;
    const field = this.document.createElement('input');
    field.type = 'hidden';
    field.name = 'manifest';
    field.value = outcome.value.manifest;
    form.append(field);
    this.document.body.append(form);
    form.submit();
  }
}
