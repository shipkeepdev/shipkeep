import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { IdentityRequestError } from '../identity/identity-api';
import { type GithubRepository, GithubApi } from '../integrations/github-api';
import { Icon } from '../shell/icon';
import { Brand } from '../ui/brand';
import { T } from '../ui/i18n';

import { type Application, DeliveryApi, type EnvironmentRef } from './delivery-api';

/** What each refusal of the API means here, in the words of this form. */
const REFUSALS: Readonly<Record<string, string>> = {
  github_app_missing: 'Create the GitHub App first, from the integrations.',
  github_installation_unavailable:
    'The GitHub App is no longer installed there, or GitHub suspended it.',
  github_repository_unavailable:
    'The GitHub App does not reach this repository: add it to the installation on GitHub.',
  github_branch_not_found: 'This branch does not exist in the repository.',
  github_config_not_found: 'The repository has no file at this path on that branch.',
  invalid_branch: 'This is not a branch name Git allows.',
  invalid_config_path:
    'The path must lead to a .yml or .yaml file in the repository, without .. segments.',
  invalid_application_config: 'The shipkeep.yml in the repository is invalid.',
  unsupported_build_type:
    'Building from the repository is not supported yet: set build.type to image in shipkeep.yml.',
  application_name_taken: 'An application with this name already exists in the environment.',
  domain_taken: 'Another application already uses one of its domains.',
  domain_reserved: 'One of its domains is the control plane’s own address.',
};

/**
 * An application whose configuration is a GitHub repository's shipkeep.yml (#213, ADR 0031): a
 * repository the organization's App reaches, a branch and a path. The control plane reads the
 * file at the branch's head; a push to that branch then deploys it, unless the environment is
 * protected.
 */
@Component({
  selector: 'sk-github-application-form',
  imports: [Brand, Icon, ReactiveFormsModule, RouterLink, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card flex flex-col gap-3 p-5" aria-labelledby="github-create-title">
      <div class="flex flex-wrap items-center gap-3.5">
        <span class="grid size-10 shrink-0 place-items-center rounded-[11px] border border-ctl"
          ><sk-brand name="github" class="size-5 text-fg"
        /></span>
        <div class="min-w-0 flex-[1_1_200px]">
          <h2 id="github-create-title" class="text-[14px] font-medium">
            {{ 'From a GitHub repository' | t }}
          </h2>
          <div class="mt-[3px] text-[12.5px] leading-[1.45] text-mute2">
            {{
              'Its shipkeep.yml is the configuration. A push to the branch deploys it, unless the environment is protected.'
                | t
            }}
          </div>
        </div>
      </div>

      @if (state() === 'unread') {
        <div class="alert flex-wrap items-center justify-between" role="alert">
          <span>{{ 'The GitHub integration could not be read.' | t }}</span>
          <button type="button" class="btn btn-sm" (click)="load()">{{ 'Try again' | t }}</button>
        </div>
      } @else if (state() === 'no-app') {
        <p class="text-[12.5px] text-mute2">
          {{ 'Connect GitHub first: an owner creates the GitHub App from the integrations.' | t }}
          <a
            class="text-fg2 underline underline-offset-2 hover:text-fg"
            [routerLink]="['/orgs', environment().organizationId, 'integrations']"
            >{{ 'Open the integrations' | t }}</a
          >
        </p>
      } @else if (state() === 'ready') {
        @if (!repositories().length) {
          <p class="text-[12.5px] text-mute2">
            {{
              'The GitHub App reaches no repository yet: install it on the repositories to deploy from.'
                | t
            }}
            <a
              class="text-fg2 underline underline-offset-2 hover:text-fg"
              [routerLink]="['/orgs', environment().organizationId, 'integrations']"
              >{{ 'Open the integrations' | t }}</a
            >
          </p>
        } @else {
          @if (problem(); as text) {
            <div class="alert" role="alert">{{ text | t }}</div>
          }
          <form [formGroup]="form" (ngSubmit)="create()" class="flex flex-col gap-3">
            <div class="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
              <div class="flex min-w-0 flex-col gap-1">
                <label for="github-repository" class="text-[12.5px] text-mute2">{{
                  'Repository' | t
                }}</label>
                <select
                  id="github-repository"
                  class="input font-mono text-[12.5px]"
                  formControlName="repository"
                  (change)="chooseRepository()"
                >
                  @for (r of repositories(); track r.id) {
                    <option [value]="key(r)">{{ r.fullName }}</option>
                  }
                </select>
              </div>
              <div class="flex min-w-0 flex-col gap-1">
                <label for="github-branch" class="text-[12.5px] text-mute2">{{
                  'Branch' | t
                }}</label>
                <input
                  id="github-branch"
                  class="input font-mono text-[12.5px]"
                  formControlName="branch"
                  autocomplete="off"
                  spellcheck="false"
                  maxlength="255"
                />
              </div>
              <div class="flex min-w-0 flex-col gap-1">
                <label for="github-config-path" class="text-[12.5px] text-mute2">{{
                  'Path of shipkeep.yml' | t
                }}</label>
                <input
                  id="github-config-path"
                  class="input font-mono text-[12.5px]"
                  formControlName="configPath"
                  autocomplete="off"
                  spellcheck="false"
                  maxlength="255"
                />
              </div>
            </div>
            <div>
              <button class="btn btn-primary" type="submit" [disabled]="busy()">
                {{ (busy() ? 'Reading the repository…' : 'Create application') | t
                }}<sk-icon name="arrow-right" />
              </button>
            </div>
          </form>
        }
      } @else {
        <p class="text-[12.5px] text-mute2">{{ 'Loading…' | t }}</p>
      }
    </section>
  `,
})
export class GithubApplicationForm {
  private readonly github = inject(GithubApi);
  private readonly api = inject(DeliveryApi);

  readonly environment = input.required<EnvironmentRef>();
  readonly created = output<Application>();

  protected readonly state = signal<'loading' | 'unread' | 'no-app' | 'ready'>('loading');
  protected readonly repositories = signal<readonly GithubRepository[]>([]);
  protected readonly busy = signal(false);
  protected readonly problem = signal<string | null>(null);
  protected readonly form = new FormGroup({
    repository: new FormControl('', { nonNullable: true }),
    branch: new FormControl('', { nonNullable: true }),
    configPath: new FormControl('shipkeep.yml', { nonNullable: true }),
  });
  private readonly organizationId = computed(() => this.environment().organizationId);
  private revision = 0;

  constructor() {
    effect(() => {
      this.organizationId();
      untracked(() => void this.load());
    });
    this.form.valueChanges.subscribe(() => {
      this.problem.set(null);
    });
  }

  async load(): Promise<void> {
    const revision = ++this.revision;
    const organizationId = this.organizationId();
    this.state.set('loading');
    try {
      const app = await this.github.app(organizationId);
      if (revision !== this.revision) return;
      if (!app) {
        this.state.set('no-app');
        return;
      }
      const listing = await this.github.repositories(organizationId);
      if (revision !== this.revision) return;
      this.repositories.set(listing.repositories);
      const first = listing.repositories.at(0);
      if (first) this.form.patchValue({ repository: this.key(first), branch: first.defaultBranch });
      this.state.set('ready');
    } catch {
      if (revision === this.revision) this.state.set('unread');
    }
  }

  protected key(repository: GithubRepository): string {
    return `${String(repository.installationId)}:${String(repository.id)}`;
  }

  /** A new repository proposes its default branch. */
  protected chooseRepository(): void {
    const chosen = this.chosen();
    if (chosen) this.form.controls.branch.setValue(chosen.defaultBranch);
  }

  private chosen(): GithubRepository | undefined {
    const key = this.form.controls.repository.value;
    return this.repositories().find((repository) => this.key(repository) === key);
  }

  protected async create(): Promise<void> {
    const repository = this.chosen();
    if (!repository || this.busy()) return;
    const { branch, configPath } = this.form.getRawValue();
    this.busy.set(true);
    this.problem.set(null);
    try {
      const application = await this.api.createGithubApplication(this.environment(), {
        installationId: repository.installationId,
        repositoryId: repository.id,
        branch: branch.trim(),
        configPath: configPath.trim() || 'shipkeep.yml',
      });
      this.created.emit(application);
    } catch (error: unknown) {
      this.problem.set(problemText(error));
    } finally {
      this.busy.set(false);
    }
  }
}

function problemText(error: unknown): string {
  if (!(error instanceof IdentityRequestError))
    return 'This request could not be completed. Try again shortly.';
  const code = error.problem?.code;
  return (code && REFUSALS[code]) ?? error.message;
}
