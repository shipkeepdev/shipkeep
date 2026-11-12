import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { FormGroup } from '@angular/forms';

import { T } from '../ui/i18n';

import { AccessApi, type ProjectToken, type Proof } from './access-api';
import { PagedList } from './paged-list';
import { ReauthForm, reauthControls } from './reauth-form';

/** Tokens tied to a project, which its administrators can see and revoke (SPEC 7). */
@Component({
  selector: 'sk-project-tokens-panel',
  imports: [DatePipe, ReauthForm, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!tokens.denied()) {
      <section aria-labelledby="project-tokens-title" class="mt-8 border-t border-line pt-6">
        <h2 id="project-tokens-title">{{ 'API tokens of this project' | t }}</h2>
        @if (notice(); as text) {
          <p role="status" class="feedback">{{ text | t }}</p>
        }
        @if (tokens.problem(); as problem) {
          <div class="feedback" role="alert">
            <p>{{ problem | t }}</p>
          </div>
        }
        @switch (tokens.state()) {
          @case ('loading') {
            <p role="status" class="text-muted">{{ 'Loading tokens…' | t }}</p>
          }
          @case ('ready') {
            @if (tokens.items().length) {
              <ul
                class="divide-y divide-line border-y border-line"
                [attr.aria-label]="'Project API tokens' | t"
              >
                @for (token of tokens.items(); track token.id) {
                  <li class="py-3">
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <span>
                        <span class="break-words">{{ token.name }}</span>
                        <span class="ml-2 text-sm text-muted">{{ token.status | t }}</span>
                        <span class="block text-sm text-muted">
                          {{ 'Created by' | t }} <code class="break-all">{{ token.createdBy }}</code
                          >{{ ', expires' | t }} {{ token.expiresAt | date: 'mediumDate' }}
                        </span>
                      </span>
                      @if (token.status === 'active') {
                        <button
                          class="button button-secondary"
                          type="button"
                          [attr.aria-label]="'Revoke token {name}' | t: { name: token.name }"
                          (click)="select(token)"
                        >
                          {{ 'Revoke' | t }}
                        </button>
                      }
                    </div>
                    @if (selected()?.id === token.id) {
                      <div class="mt-4">
                        <p class="hint">
                          {{ '{name} stops working immediately.' | t: { name: token.name } }}
                        </p>
                        <sk-reauth-form
                          prefix="project-token"
                          [label]="'Revoke token' | t"
                          [form]="form"
                          [send]="revoke"
                          (done)="revoked()"
                        >
                          <button
                            secondary
                            class="button button-secondary"
                            type="button"
                            (click)="selected.set(null)"
                          >
                            {{ 'Cancel' | t }}
                          </button>
                        </sk-reauth-form>
                      </div>
                    }
                  </li>
                }
              </ul>
              @if (tokens.hasMore()) {
                <div class="mt-4">
                  <button
                    class="button button-secondary"
                    type="button"
                    [disabled]="tokens.loadingMore()"
                    (click)="tokens.more()"
                  >
                    {{ (tokens.loadingMore() ? 'Loading…' : 'Show more tokens') | t }}
                  </button>
                </div>
              }
            } @else {
              <p class="border-y border-line py-6 text-muted">
                {{
                  'No token is tied to this project. Create one from your account security page.'
                    | t
                }}
              </p>
            }
          }
        }
      </section>
    }
  `,
})
export class ProjectTokensPanel {
  private readonly api = inject(AccessApi);
  readonly organizationId = input.required<string>();
  readonly projectId = input.required<string>();
  protected readonly tokens = new PagedList<ProjectToken>((cursor) =>
    this.api.projectTokens(this.organizationId(), this.projectId(), cursor),
  );
  protected readonly selected = signal<ProjectToken | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly form = new FormGroup(reauthControls());
  protected readonly revoke = (proof: Proof, key: string): Promise<void> => {
    const target = this.selected();
    if (!target) throw new Error('No token is selected.');
    return this.api.revokeProjectToken(
      this.organizationId(),
      this.projectId(),
      target.id,
      proof,
      key,
    );
  };

  constructor() {
    effect(() => {
      this.organizationId();
      this.projectId();
      this.selected.set(null);
      this.notice.set(null);
      void this.tokens.refresh();
    });
  }

  protected select(token: ProjectToken): void {
    this.notice.set(null);
    this.form.reset();
    this.selected.set(token);
  }
  protected revoked(): void {
    this.selected.set(null);
    this.notice.set('The token has been revoked.');
    void this.tokens.refresh();
  }
}
