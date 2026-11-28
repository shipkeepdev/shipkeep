import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { type EnvironmentRef } from '../delivery/delivery-api';
import { PrivateClipboard } from '../identity/private-clipboard';
import { Icon } from '../shell/icon';
import { T } from '../ui/i18n';

type CopyTarget = 'organization' | 'project' | 'environment' | 'export';

/** Identifiers, export line and token link for using this environment from `shipkeep` CLI (#433). */
@Component({
  selector: 'sk-environment-cli',
  imports: [Icon, RouterLink, T],
  providers: [PrivateClipboard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="environment-cli-title" class="card mt-2 grid gap-4 p-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 id="environment-cli-title" class="text-[15px] font-semibold">
          {{ 'Use from the CLI' | t }}
        </h2>
        <a
          class="btn btn-sm"
          [routerLink]="['/account']"
          [queryParams]="{
            section: 'tokens',
            organizationId: environment().organizationId,
            projectId: environment().projectId,
            environmentId: environment().environmentId,
          }"
        >
          <sk-icon name="key" />{{ 'Create an API token for this environment' | t }}
        </a>
      </div>
      <div class="grid gap-2.5 sm:grid-cols-3">
        @for (item of identifiers(); track item.key) {
          <div
            class="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-line px-3 py-2"
          >
            <div class="min-w-0">
              <div class="text-[11px] uppercase tracking-wider text-mute">
                {{ item.label | t }}
              </div>
              <code class="block truncate font-mono text-[12px] text-fg">{{ item.value }}</code>
            </div>
            <button
              type="button"
              class="btn btn-sm shrink-0"
              [attr.aria-label]="item.copyLabel | t"
              (click)="copy(item.key, item.value)"
            >
              <sk-icon name="copy" />{{ 'Copy' | t }}
            </button>
          </div>
        }
      </div>
      <div class="grid gap-2">
        <pre
          class="code-box min-w-0"
          role="region"
          tabindex="0"
          [attr.aria-label]="'CLI environment variables' | t"
          >{{ exportLine() }}</pre>
        <div class="flex flex-wrap items-center gap-3">
          <button type="button" class="btn btn-sm" (click)="copy('export', exportLine())">
            <sk-icon name="copy" />{{ 'Copy export command' | t }}
          </button>
          @if (copied() && clipboard.message(); as message) {
            <span class="text-[12px] text-mute" role="status">{{ message | t }}</span>
          }
        </div>
      </div>
    </section>
  `,
})
export class EnvironmentCli {
  protected readonly clipboard = inject(PrivateClipboard);
  readonly environment = input.required<EnvironmentRef>();
  protected readonly copied = signal<CopyTarget | null>(null);

  protected readonly identifiers = computed(
    (): readonly { key: CopyTarget; label: string; copyLabel: string; value: string }[] => [
      {
        key: 'organization',
        label: 'Organization',
        copyLabel: 'Copy organization ID',
        value: this.environment().organizationId,
      },
      {
        key: 'project',
        label: 'Project',
        copyLabel: 'Copy project ID',
        value: this.environment().projectId,
      },
      {
        key: 'environment',
        label: 'Environment',
        copyLabel: 'Copy environment ID',
        value: this.environment().environmentId,
      },
    ],
  );

  protected readonly exportLine = computed(() => {
    const { organizationId, projectId, environmentId } = this.environment();
    return `export SHIPKEEP_ORG=${organizationId} SHIPKEEP_PROJECT=${projectId} SHIPKEEP_ENV=${environmentId}`;
  });

  protected async copy(target: CopyTarget, value: string): Promise<void> {
    this.copied.set(target);
    await this.clipboard.copy(value);
  }
}
