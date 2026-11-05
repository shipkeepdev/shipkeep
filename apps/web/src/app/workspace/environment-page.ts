import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { IdentityRequestError } from '../identity/identity-api';

import { type Environment, WorkspaceApi } from './workspace-api';

/** One environment. Applications and secrets are added by the next screens (M3.7b, M3.4). */
@Component({
  selector: 'sk-environment-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav aria-label="Breadcrumb" class="mb-4 text-sm">
      <a routerLink="/orgs">Organizations</a> /
      <a [routerLink]="['/orgs', organizationId()]">Organization</a> /
      <a [routerLink]="['/orgs', organizationId(), 'projects', projectId()]">Project</a>
    </nav>
    <section class="max-w-3xl" aria-labelledby="environment-title">
      <h1 id="environment-title">{{ environment()?.name ?? 'Environment' }}</h1>
      @if (missing()) {
        <div class="feedback" role="alert">
          <p>{{ missing() }}</p>
        </div>
      } @else if (environment(); as current) {
        <p class="page-intro">
          {{
            current.protected
              ? 'Protected: only administrators deploy here and set its secrets.'
              : 'Developers can deploy here.'
          }}
        </p>
      }
    </section>
  `,
})
export class EnvironmentPage {
  private readonly api = inject(WorkspaceApi);
  readonly organizationId = input.required<string>();
  readonly projectId = input.required<string>();
  readonly environmentId = input.required<string>();
  protected readonly environment = signal<Environment | null>(null);
  protected readonly missing = signal<string | null>(null);

  constructor() {
    effect(() => {
      void this.load(this.organizationId(), this.projectId(), this.environmentId());
    });
  }

  private async load(
    organizationId: string,
    projectId: string,
    environmentId: string,
  ): Promise<void> {
    this.missing.set(null);
    try {
      this.environment.set(await this.api.environment(organizationId, projectId, environmentId));
    } catch (error: unknown) {
      this.environment.set(null);
      this.missing.set(
        error instanceof IdentityRequestError
          ? error.message
          : 'This environment could not be loaded.',
      );
    }
  }
}
