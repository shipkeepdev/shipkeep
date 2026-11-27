import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  effect,
  type ElementRef,
  inject,
  Injector,
  input,
  viewChild,
} from '@angular/core';

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
      <section class="card overflow-hidden" aria-labelledby="configuration-title">
        <div
          class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-[18px] pt-4 pb-3"
        >
          <h2 id="configuration-title" class="card-title m-0">{{ 'Configuration' | t }}</h2>
          <span class="min-w-0 truncate font-mono text-[11px] text-dim">
            {{ repo.fullName }} · {{ repo.branch }} · {{ repo.configPath }}
          </span>
        </div>
        <div class="flex flex-col gap-3 px-3 pb-3.5">
          @if (store.file(); as file) {
            @if (!file.valid) {
              <div class="note note-ours" role="status">
                <span class="dot mt-1.5 text-rose"></span>
                <span>{{
                  'The file in the repository is not a valid configuration for this application: correct it below, or in the repository.'
                    | t
                }}</span>
              </div>
            } @else if (!file.applied) {
              <div class="note note-warn" role="status">
                <span class="dot mt-1.5 text-amber"></span>
                <span>{{
                  'The file changed in the repository: this application runs the one of commit {applied}, and {branch} is at {head}. A push to {branch} applies it, unless the environment is protected.'
                    | t
                      : {
                          applied: file.appliedCommitSha.slice(0, 7),
                          head: file.commitSha.slice(0, 7),
                          branch: file.branch,
                        }
                }}</span>
              </div>
            } @else {
              <div class="note" role="status">
                <span class="dot mt-1.5 text-green"></span>
                <span>{{
                  'The application runs this file, at commit {head}.'
                    | t: { head: file.commitSha.slice(0, 7) }
                }}</span>
              </div>
            }
          }
          @if (store.unread()) {
            <div class="alert flex-wrap items-center justify-between" role="alert">
              <span>{{ 'The file could not be read from the repository.' | t }}</span>
              <button class="btn btn-sm" type="button" (click)="store.load(!store.file())">
                {{ 'Try again' | t }}
              </button>
            </div>
          }
          @if (store.conflict()) {
            <div class="alert flex-wrap items-center justify-between" role="alert">
              <span>{{
                'The file changed in the repository since you opened it. Your draft has been kept.'
                  | t
              }}</span>
              <button
                class="btn btn-sm"
                type="button"
                [disabled]="store.runner.busy() || !!store.runner.cooldown()"
                (click)="store.reload()"
              >
                {{ 'Load the latest file' | t }}
              </button>
            </div>
          }
          @if (store.runner.problem(); as problem) {
            <p class="alert m-0" role="alert">{{ problem | t }}</p>
          }
          @if (store.notice(); as notice) {
            <p class="note m-0" role="status">{{ notice | t }}</p>
          }
          @if (store.written(); as written) {
            <div
              #written
              class="alert alert-ok flex-wrap items-center justify-between focus:outline-none"
              role="status"
              tabindex="-1"
            >
              <span>
                @if (written.via === 'pull_request') {
                  {{
                    'Pull request #{number} opened. Merging it into {branch} deploys the change, unless the environment is protected.'
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
            <div id="config-errors" class="alert flex-col" role="alert">
              <span>{{ 'Fix these configuration errors:' | t }}</span>
              <ul class="m-0 list-disc pl-5">
                @for (issue of store.issues(); track $index) {
                  <li>
                    <code class="font-mono">{{ issue.path || '/' }}</code>
                    {{ issue.message | issue }}
                  </li>
                }
              </ul>
            </div>
          }
          @if (store.file()) {
            <form (submit)="$event.preventDefault(); store.review()" class="flex flex-col gap-3">
              <label for="configuration-draft" class="sr-only">{{ repo.configPath }}</label>
              <textarea
                #editor
                id="configuration-draft"
                class="block min-h-72 w-full resize-y rounded-[10px] border border-line bg-black px-3.5 py-2.5 font-mono text-[12px] leading-[1.75] text-fg2 caret-coral outline-none focus:border-ctl2"
                [class.border-danger]="store.issues().length > 0"
                spellcheck="false"
                autocomplete="off"
                [value]="store.draft()"
                [readOnly]="store.runner.busy()"
                [attr.aria-invalid]="store.issues().length > 0"
                [attr.aria-describedby]="store.issues().length ? 'config-errors' : null"
                (input)="store.edit(editor.value)"
              ></textarea>
              @if (!store.preview()) {
                <div class="flex flex-wrap gap-2">
                  <button
                    class="btn btn-sm btn-primary"
                    type="submit"
                    [disabled]="store.runner.busy() || store.conflict()"
                  >
                    {{ 'Review changes' | t }}
                  </button>
                </div>
              }
            </form>
          }
          @if (store.preview(); as preview) {
            <div class="overflow-hidden rounded-[10px] border border-line">
              <div
                class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3.5 pt-3 pb-2"
              >
                <span class="text-[12.5px] font-medium">{{ 'Changes to write' | t }}</span>
                <span class="text-[11.5px] text-dim">{{
                  '− In the repository · + Written' | t
                }}</span>
              </div>
              <pre
                class="m-0 max-h-96 overflow-auto pb-2.5 font-mono text-[12px] leading-[1.75]"
                tabindex="0"
                [attr.aria-label]="'Changes to write' | t"
              >@for (line of preview.diff; track $index) {@if (line.kind === 'skipped') {<span class="block px-3.5 text-dim">{{ '⋯ {count} unchanged lines' | t: { count: line.count ?? 0 } }}</span>} @else {<span class="block px-3.5" [class.diff-added]="line.kind === 'added'" [class.diff-removed]="line.kind === 'removed'" [class.text-fg3]="line.kind === 'same'">{{ line.kind === 'removed' ? '- ' : line.kind === 'added' ? '+ ' : '  ' }}{{ line.text }}</span>}}</pre>
            </div>
            <p class="m-0 px-1.5 text-[12px] text-mute2">
              @if (preview.writeMode === 'commit') {
                {{
                  'It is committed to {branch}. If {branch} is protected, a pull request is opened instead.'
                    | t: { branch: preview.branch }
                }}
              } @else {
                {{
                  'It goes to a branch of its own, in a pull request into {branch}.'
                    | t: { branch: preview.branch }
                }}
              }
            </p>
            <div class="flex flex-wrap gap-2">
              <button
                #write
                class="btn btn-sm btn-primary"
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
              <button
                class="btn btn-sm"
                type="button"
                [disabled]="store.runner.busy()"
                (click)="back()"
              >
                {{ 'Back to editing' | t }}
              </button>
            </div>
          }
          @if (store.runner.cooldown()) {
            <p role="status" class="m-0 px-1.5 text-[12px] text-mute2">
              {{ 'Try again in {s} seconds.' | t: { s: store.runner.cooldown() } }}
            </p>
          }
        </div>
      </section>
    }
  `,
})
export class RepositoryConfigEditor {
  protected readonly store = inject(RepositoryConfigStore);
  private readonly injector = inject(Injector);
  readonly application = input.required<Application>();
  readonly environment = input.required<EnvironmentRef>();
  private readonly editor = viewChild<ElementRef<HTMLTextAreaElement>>('editor');
  private readonly writeButton = viewChild<ElementRef<HTMLButtonElement>>('write');
  private readonly writtenNote = viewChild<ElementRef<HTMLElement>>('written');

  constructor() {
    effect(() => {
      void this.store.open(this.environment(), this.application());
    });
    // Each step replaces the control that led to it: the focus goes to the next step, never back
    // to the start of the page.
    effect(() => {
      this.writeButton()?.nativeElement.focus();
    });
    effect(() => {
      this.writtenNote()?.nativeElement.focus();
    });
  }

  protected back(): void {
    this.store.back();
    afterNextRender(() => this.editor()?.nativeElement.focus(), { injector: this.injector });
  }
}
