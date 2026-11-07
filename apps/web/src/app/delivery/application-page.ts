import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { IdentityRequestError } from '../identity/identity-api';
import { MutationRunner } from '../identity/mutation-runner';
import { Collection } from '../workspace/collection';

import { ConfigurationEditor } from './configuration-editor';
import {
  type Application,
  DeliveryApi,
  type Deployment,
  type DomainStatus,
  type EnvironmentRef,
} from './delivery-api';

const FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'rolled_back']);
/** While a deployment runs, its state is refreshed this often. */
const POLL_MS = 3000;

/** One application: its configuration, deploying it and following its deployments. */
@Component({
  selector: 'sk-application-page',
  imports: [RouterLink, ConfigurationEditor],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav aria-label="Breadcrumb" class="mb-4 text-sm">
      <a routerLink="/orgs">Organizations</a> /
      <a
        [routerLink]="[
          '/orgs',
          organizationId(),
          'projects',
          projectId(),
          'environments',
          environmentId(),
        ]"
        >Environment</a
      >
    </nav>
    <section class="max-w-3xl" aria-labelledby="application-title">
      <h1 id="application-title">{{ application()?.name ?? 'Application' }}</h1>
      @if (missing()) {
        <div class="feedback" role="alert">
          <p>{{ missing() }}</p>
        </div>
      } @else if (application(); as current) {
        @if (runner.problem(); as problem) {
          <div class="feedback" role="alert">
            <p>{{ problem }}</p>
          </div>
        }
        <div class="mb-8 flex flex-wrap items-center gap-3">
          <button
            class="button"
            type="button"
            [disabled]="runner.busy() || !!active()"
            (click)="deploy()"
          >
            {{ runner.busy() ? 'Starting…' : 'Deploy' }}
          </button>
          @if (active(); as running) {
            <span role="status">Deployment {{ running.state }}…</span>
            <button
              class="button button-secondary"
              type="button"
              [disabled]="runner.busy()"
              (click)="cancel(running.id)"
            >
              Cancel deployment
            </button>
          }
        </div>
        @if (domains.items().length) {
          <section aria-labelledby="domains-title" class="border-t border-line pt-6">
            <h2 id="domains-title">Domains</h2>
            <ul class="mb-3 divide-y divide-line border-y border-line" aria-label="Domains">
              @for (domain of domains.items(); track domain.hostname) {
                <li class="py-3">
                  <code>{{ domain.hostname }}</code>
                  <span class="ml-2 text-sm text-muted">{{ describeDomain(domain) }}</span>
                </li>
              }
            </ul>
            <p class="hint mb-8">
              Point each domain at the server running this application. Certificates are issued
              automatically once it answers on ports 80 and 443.
            </p>
          </section>
        }
        <section aria-labelledby="deployments-title" class="border-t border-line pt-6">
          <h2 id="deployments-title">Deployments</h2>
          @if (deployments.items().length) {
            <table class="mb-8 w-full text-left text-sm">
              <thead>
                <tr class="border-b border-line">
                  <th class="py-2 font-semibold">Started</th>
                  <th class="py-2 font-semibold">State</th>
                  <th class="py-2 font-semibold">Details</th>
                  <th class="py-2"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (deployment of deployments.items(); track deployment.id) {
                  <tr class="border-b border-line align-top">
                    <td class="py-2 tabular-nums">
                      {{ deployment.startedAt.slice(0, 19).replace('T', ' ') }}
                    </td>
                    <td
                      class="py-2"
                      [class.text-danger]="deployment.state === 'failed'"
                      [class.text-success]="deployment.state === 'succeeded'"
                    >
                      {{ deployment.state }}
                    </td>
                    <td class="py-2 text-muted">
                      {{
                        deployment.error ?? (deployment.trigger === 'rollback' ? 'Rollback' : '')
                      }}
                    </td>
                    <td class="py-2 text-right">
                      @if (canRollBack(deployment)) {
                        <button
                          class="button button-secondary"
                          type="button"
                          [disabled]="runner.busy() || !!active()"
                          (click)="rollback(deployment.id)"
                        >
                          Roll back
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
            <p class="hint mb-8">
              Rolling back deploys that version's image and configuration again, without its release
              command. Database migrations are not undone.
            </p>
          } @else {
            <p class="mb-8 border-y border-line py-6 text-muted">Not deployed yet.</p>
          }
        </section>
        <sk-configuration-editor [application]="current" [environment]="environment()" />
      }
    </section>
  `,
})
export class ApplicationPage {
  private readonly api = inject(DeliveryApi);
  protected readonly runner = inject(MutationRunner);
  readonly organizationId = input.required<string>();
  readonly projectId = input.required<string>();
  readonly environmentId = input.required<string>();
  readonly applicationId = input.required<string>();
  protected readonly environment = computed<EnvironmentRef>(() => ({
    organizationId: this.organizationId(),
    projectId: this.projectId(),
    environmentId: this.environmentId(),
  }));
  protected readonly application = signal<Application | null>(null);
  protected readonly missing = signal<string | null>(null);
  protected readonly deployments = new Collection<Deployment>(() =>
    this.api.deployments(this.environment(), this.applicationId()),
  );
  protected readonly domains = new Collection<DomainStatus>(() =>
    this.api.domains(this.environment(), this.applicationId()),
  );
  protected readonly active = computed(() =>
    this.deployments.items().find((deployment) => !FINISHED.has(deployment.state)),
  );
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loadRevision = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      ++this.loadRevision;
      clearTimeout(this.timer);
    });
    effect(() => {
      void this.load(this.environment(), this.applicationId());
    });
  }

  private async load(environment: EnvironmentRef, applicationId: string): Promise<void> {
    const revision = ++this.loadRevision;
    this.application.set(null);
    this.missing.set(null);
    try {
      const application = await this.api.application(environment, applicationId);
      if (revision !== this.loadRevision) return;
      this.application.set(application);
      void this.domains.refresh();
      await this.refresh();
    } catch (error: unknown) {
      if (revision !== this.loadRevision) return;
      this.application.set(null);
      this.missing.set(
        error instanceof IdentityRequestError
          ? error.message
          : 'This application could not be loaded.',
      );
    }
  }

  /** Reloads the deployments, and keeps doing so while one is still running. */
  private async refresh(): Promise<void> {
    clearTimeout(this.timer);
    await this.deployments.refresh();
    if (this.active())
      this.timer = setTimeout(() => {
        void this.refresh();
      }, POLL_MS);
  }

  protected async deploy(): Promise<void> {
    const outcome = await this.runner.run({ deploy: this.applicationId() }, () =>
      this.api.deploy(this.environment(), this.applicationId()),
    );
    if (outcome.ok) await this.refresh();
  }

  protected describeDomain(domain: DomainStatus): string {
    switch (domain.status) {
      case 'public':
        return `points to ${domain.addresses.join(', ')}`;
      case 'private':
        return 'points to a private address, so it cannot get a certificate';
      case 'none':
        return 'no DNS record yet';
      default:
        return 'DNS lookup failed; try again later';
    }
  }

  /** Versions that ran, other than the one serving now (the latest success). */
  protected canRollBack(deployment: Deployment): boolean {
    if (deployment.state !== 'succeeded' && deployment.state !== 'rolled_back') return false;
    const serving = this.deployments.items().find((item) => item.state === 'succeeded');
    return deployment.releaseId !== serving?.releaseId;
  }

  protected async rollback(deploymentId: string): Promise<void> {
    const outcome = await this.runner.run({ rollback: deploymentId }, () =>
      this.api.rollback(this.environment(), this.applicationId(), deploymentId),
    );
    if (outcome.ok) await this.refresh();
  }

  protected async cancel(deploymentId: string): Promise<void> {
    const outcome = await this.runner.run({ cancel: deploymentId }, () =>
      this.api.cancel(this.environment(), this.applicationId(), deploymentId),
    );
    if (outcome.ok) await this.refresh();
  }
}
