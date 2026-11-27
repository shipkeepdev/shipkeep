import { ChangeDetectionStrategy, Component, effect, inject, input } from '@angular/core';

import { MutationRunner } from '../identity/mutation-runner';
import { Icon } from '../shell/icon';
import { IssueText } from '../ui/config-issue';
import { T } from '../ui/i18n';

import { type Application, type EnvironmentRef } from './delivery-api';
import { RepositoryConfigStore } from './repository-config-store';

/**
 * A Git application's configuration (#214): its repository's shipkeep.yml, whether the application
 * runs it, and an editor whose change goes back to the repository as a pull request or a commit,
 * after a review of the exact lines written.
 */
@Component({
  selector: 'sk-repository-config-editor',
  imports: [Icon, IssueText, T],
  providers: [MutationRunner, RepositoryConfigStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let repo = application().repository;
    @if (repo) {
      <p id="config-hint" class="hint mb-4">
        {{
          'This configuration is the {path} of {repository}, on {branch}. A change made here goes to the repository, as a pull request or a commit as the project says; a push to {branch} then deploys it, unless the environment is protected.'
            | t: { path: repo.configPath, repository: repo.fullName, branch: repo.branch }
        }}
      </p>
      @if (store.file(); as file) {
        @if (!file.valid) {
          <p class="feedback" role="status">
            {{
              'The file in the repository is not a valid configuration for this application: correct it below, or in the repository.'
                | t
            }}
          </p>
        } @else if (!file.applied) {
          <p class="feedback" role="status">
            {{
              'The file changed in the repository: this application runs the one of commit {applied}, and {branch} is at {head}. A push to {branch} applies it, unless the environment is protected.'
                | t
                  : {
                      applied: file.appliedCommitSha.slice(0, 7),
                      head: file.commitSha.slice(0, 7),
                      branch: file.branch,
                    }
            }}
          </p>
        } @else {
          <p class="mb-4 text-sm text-muted">
            {{
              'The application runs this file, at commit {head}.'
                | t: { head: file.commitSha.slice(0, 7) }
            }}
          </p>
        }
      }
      @if (store.unread()) {
        <div class="feedback" role="alert">
          <p>{{ 'The file could not be read from the repository.' | t }}</p>
          <button
            class="button button-secondary mt-3"
            type="button"
            (click)="store.load(!store.file())"
          >
            {{ 'Try again' | t }}
          </button>
        </div>
      }
      @if (store.conflict()) {
        <div class="feedback" role="alert">
          <p>
            {{
              'The file changed in the repository since you opened it. Your draft has been kept.'
                | t
            }}
          </p>
          <button
            class="button button-secondary mt-3"
            type="button"
            [disabled]="store.runner.busy() || !!store.runner.cooldown()"
            (click)="store.reload()"
          >
            {{ 'Load the latest file' | t }}
          </button>
        </div>
      }
      @if (store.runner.problem(); as problem) {
        <p class="feedback" role="alert">{{ problem | t }}</p>
      }
      @if (store.notice(); as notice) {
        <p class="feedback" role="status">{{ notice | t }}</p>
      }
      @if (store.written(); as written) {
        <div class="feedback flex flex-wrap items-center justify-between gap-3" role="status">
          <span>
            @if (written.via === 'pull_request') {
              {{
                'Pull request #{number} opened. Merging it into {branch} deploys the change.'
                  | t: { number: written.number ?? 0, branch: repo.branch }
              }}
            } @else {
              {{
                'Committed to {branch}. Its push deploys the change, unless the environment is protected.'
                  | t: { branch: repo.branch }
              }}
            }
          </span>
          <a class="btn btn-sm" [href]="written.url" rel="noopener"
            ><sk-icon name="external-link" />{{ 'Open on GitHub' | t }}</a
          >
        </div>
      }
      @if (store.issues().length) {
        <div id="config-errors" class="feedback" role="alert">
          <p>{{ 'Fix these configuration errors:' | t }}</p>
          <ul class="list-disc pl-5">
            @for (issue of store.issues(); track $index) {
              <li>
                <code>{{ issue.path || '/' }}</code> {{ issue.message | issue }}
              </li>
            }
          </ul>
        </div>
      }
      @if (store.file()) {
        <form (submit)="$event.preventDefault(); store.review()" class="grid gap-4">
          <div>
            <label for="configuration-draft">{{ repo.configPath }}</label>
            <textarea
              #editor
              id="configuration-draft"
              class="block min-h-72 w-full resize-y rounded-md border border-control p-3 font-mono text-sm caret-accent disabled:bg-panel"
              [class.border-danger]="store.issues().length > 0"
              spellcheck="false"
              autocomplete="off"
              [value]="store.draft()"
              [readOnly]="store.runner.busy()"
              [attr.aria-invalid]="store.issues().length > 0"
              [attr.aria-describedby]="
                store.issues().length ? 'config-hint config-errors' : 'config-hint'
              "
              (input)="store.edit(editor.value)"
            ></textarea>
          </div>
          <div>
            <button
              class="button button-secondary"
              type="submit"
              [disabled]="store.runner.busy() || store.conflict()"
            >
              {{ 'Review changes' | t }}
            </button>
          </div>
        </form>
      }
      @if (store.preview(); as preview) {
        <div class="mt-6">
          <h3 class="mb-2 font-semibold">{{ 'Changes to write' | t }}</h3>
          <p class="hint mb-3">
            {{ '− In the repository · + Written' | t }}
          </p>
          <pre
            class="mb-4 max-h-96 overflow-auto rounded-md bg-panel p-4 text-sm"
            tabindex="0"
            [attr.aria-label]="'Changes to write' | t"
          >@for (line of preview.diff; track $index) {@if (line.kind === 'skipped') {<span class="block text-muted">{{ '⋯ {count} unchanged lines' | t: { count: line.count ?? 0 } }}</span>} @else {<span class="block" [class.text-danger]="line.kind === 'removed'" [class.text-success]="line.kind === 'added'">{{ line.kind === 'removed' ? '- ' : line.kind === 'added' ? '+ ' : '  ' }}{{ line.text }}</span>}}</pre>
          @if (preview.writeMode === 'commit') {
            <p class="hint mb-3">
              {{
                'It is committed to {branch}. If {branch} is protected, a pull request is opened instead.'
                  | t: { branch: preview.branch }
              }}
            </p>
          } @else {
            <p class="hint mb-3">
              {{
                'It goes to a branch of its own, in a pull request into {branch}.'
                  | t: { branch: preview.branch }
              }}
            </p>
          }
          <button
            class="button"
            type="button"
            [disabled]="
              store.runner.busy() ||
              store.conflict() ||
              !!store.runner.cooldown() ||
              store.runner.restartRequired()
            "
            (click)="store.write()"
          >
            @if (store.runner.busy()) {
              {{ 'Writing…' | t }}
            } @else if (preview.writeMode === 'commit') {
              {{ 'Commit to {branch}' | t: { branch: preview.branch } }}
            } @else {
              {{ 'Open a pull request' | t }}
            }
          </button>
        </div>
      }
      @if (store.runner.cooldown()) {
        <p role="status" class="hint">
          {{ 'Try again in {s} seconds.' | t: { s: store.runner.cooldown() } }}
        </p>
      }
    }
  `,
})
export class RepositoryConfigEditor {
  protected readonly store = inject(RepositoryConfigStore);
  readonly application = input.required<Application>();
  readonly environment = input.required<EnvironmentRef>();

  constructor() {
    effect(() => {
      void this.store.open(this.environment(), this.application());
    });
  }
}
