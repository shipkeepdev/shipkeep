import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  type OnInit,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { IdentityRequestError } from '../identity/identity-api';
import { Icon } from '../shell/icon';
import { Brand } from '../ui/brand';
import { T } from '../ui/i18n';

import { GithubApi } from './github-api';

type Outcome =
  | { readonly kind: 'working' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'not_connected'; readonly appUrl: string | null }
  | { readonly kind: 'failed' };

/**
 * Where GitHub sends the owner back after creating the App (ADR 0031): the code and state in the
 * URL are given to the control plane once, then the page leaves for the integrations. A link
 * reused or expired says so; an App GitHub created that could not be kept says where to delete it.
 */
@Component({
  selector: 'sk-github-return-page',
  imports: [Brand, Icon, RouterLink, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-[18px]">
      <div class="page-head">
        <div>
          <h1 class="page-title flex items-center gap-2.5">
            <sk-brand name="github" class="size-[22px]" />{{ 'GitHub App' | t }}
          </h1>
        </div>
      </div>
      <div class="card flex flex-col gap-3 p-5" role="status">
        @switch (outcome().kind) {
          @case ('working') {
            <p class="text-[13px] text-fg2">{{ 'Connecting the App GitHub created…' | t }}</p>
          }
          @case ('invalid') {
            <p class="text-[13px] text-fg2">
              {{ 'This link expired or was already used. Start again from the integrations.' | t }}
            </p>
          }
          @case ('not_connected') {
            <p class="text-[13px] text-fg2">
              {{
                'GitHub created the App, but Shipkeep could not keep it. Delete it on GitHub, then start again.'
                  | t
              }}
            </p>
            @if (appUrl(); as url) {
              <a class="btn btn-sm w-fit" [href]="url" rel="noopener"
                ><sk-icon name="external-link" />{{ 'Open the App on GitHub' | t }}</a
              >
            }
          }
          @case ('failed') {
            <p class="text-[13px] text-fg2">
              {{ 'GitHub could not be reached. Try again in a moment.' | t }}
            </p>
          }
        }
        @if (outcome().kind !== 'working') {
          <a class="btn btn-sm w-fit" [routerLink]="['/orgs', organizationId(), 'integrations']">{{
            'Back to the integrations' | t
          }}</a>
        }
      </div>
    </div>
  `,
})
export class GithubReturnPage implements OnInit {
  private readonly api = inject(GithubApi);
  private readonly router = inject(Router);

  readonly organizationId = input.required<string>();
  /** GitHub's query parameters, bound from the URL. */
  readonly code = input<string>();
  readonly state = input<string>();

  protected readonly outcome = signal<Outcome>({ kind: 'working' });

  ngOnInit(): void {
    void this.connect();
  }

  private async connect(): Promise<void> {
    const code = this.code();
    const state = this.state();
    if (!code || !state) {
      this.outcome.set({ kind: 'invalid' });
      return;
    }
    try {
      await this.api.connect(this.organizationId(), { code, state });
    } catch (error: unknown) {
      this.outcome.set(outcomeOf(error));
      return;
    }
    // The code and state leave the address bar with the page.
    await this.router.navigate(['/orgs', this.organizationId(), 'integrations'], {
      replaceUrl: true,
      queryParams: { connected: 'github' },
    });
  }

  protected appUrl(): string | null {
    const outcome = this.outcome();
    return outcome.kind === 'not_connected' ? outcome.appUrl : null;
  }
}

function outcomeOf(error: unknown): Outcome {
  if (!(error instanceof IdentityRequestError)) return { kind: 'failed' };
  const code = error.problem?.code;
  if (code === 'github_app_flow_invalid') return { kind: 'invalid' };
  if (code === 'github_app_not_connected')
    return { kind: 'not_connected', appUrl: error.problem?.appUrl ?? null };
  if (code === 'github_app_exists') return { kind: 'invalid' };
  return { kind: 'failed' };
}
