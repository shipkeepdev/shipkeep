import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';

import { Collection } from '../workspace/collection';

import { configDiff } from './config-diff';
import { DeliveryApi, type EnvironmentRef, type Release } from './delivery-api';

/** Releases of an application, each comparable with the one before it (PLAN M3.5b). */
@Component({
  selector: 'sk-release-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (releases.items().length) {
      <section aria-labelledby="releases-title" class="border-t border-line pt-6">
        <h2 id="releases-title">Releases</h2>
        <ul class="mb-8 divide-y divide-line border-y border-line" aria-label="Releases">
          @for (release of releases.items(); track release.id; let index = $index) {
            <li class="py-3">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <span>
                  <strong>#{{ release.number }}</strong>
                  <code class="ml-2 break-all text-sm">{{ release.image }}</code>
                  <span class="ml-2 text-sm text-muted tabular-nums">{{
                    release.createdAt.slice(0, 16).replace('T', ' ')
                  }}</span>
                </span>
                @if (releases.items()[index + 1]) {
                  <button
                    class="button button-secondary"
                    type="button"
                    [attr.aria-expanded]="open() === release.id"
                    (click)="toggle(release.id)"
                  >
                    {{ open() === release.id ? 'Hide changes' : 'Show changes' }}
                  </button>
                }
              </div>
              @if (open() === release.id) {
                <pre
                  class="mt-3 overflow-x-auto rounded-md bg-panel p-3 text-sm"
                  tabindex="0"
                  [attr.aria-label]="'Changes in release ' + release.number"
                  >{{ changes(index) }}</pre>
              }
            </li>
          }
        </ul>
      </section>
    }
  `,
})
export class ReleaseHistory {
  private readonly api = inject(DeliveryApi);
  readonly environment = input.required<EnvironmentRef>();
  readonly applicationId = input.required<string>();
  /** Changes when a deployment starts, so a new release appears. */
  readonly revision = input.required<number>();
  protected readonly releases = new Collection<Release>(() =>
    this.api.releases(this.environment(), this.applicationId()),
  );
  protected readonly open = signal<string | null>(null);

  constructor() {
    effect(() => {
      this.revision();
      void this.releases.refresh();
    });
  }

  protected toggle(id: string): void {
    this.open.update((current) => (current === id ? null : id));
  }

  /** The list is newest first, so the previous release is the next item. */
  protected changes(index: number): string {
    const items = this.releases.items();
    const release = items.at(index);
    const previous = items.at(index + 1);
    if (!release || !previous) return '';
    const lines = configDiff(previous.config, release.config);
    return lines.length ? lines.join('\n') : 'Same configuration.';
  }
}
