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

import { GREEN, GREY, RED } from '../dashboard/format';
import { MutationRunner } from '../identity/mutation-runner';
import { I18n, LocalDate, T } from '../ui/i18n';
import { ConfirmByName } from '../workspace/confirm-by-name';

import { FleetApi, type UntrackedContainer } from './fleet-api';

const STATE_COLORS: Readonly<Record<string, string>> = {
  running: GREEN,
  restarting: GREEN,
  exited: RED,
  dead: RED,
};

/**
 * Untracked containers of a server (#501): what it runs for an application of this organization
 * that no placed replica matches, as after a restore from an older backup. Each is removed on its
 * typed name (SPEC 3.6); its volumes stay. Hidden while there is none.
 */
@Component({
  selector: 'sk-untracked-containers',
  imports: [ConfirmByName, LocalDate, T],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (shown().length || asked() || unread()) {
      <section class="flex flex-col gap-3" aria-labelledby="untracked-title">
        <div>
          <h2 id="untracked-title" class="sec-title">{{ 'Untracked containers' | t }}</h2>
          <p class="sec-desc text-pretty">
            {{
              'This server runs them for an application of this organization, but no deployment it knows placed them here: after a restore from an older backup, they belong to deployments the backup does not know. Remove one once you have checked that it is no longer needed; its volumes stay.'
                | t
            }}
          </p>
        </div>
        @if (unread()) {
          <div class="alert flex-wrap items-center justify-between" role="alert">
            <span>{{ 'The untracked containers could not be read.' | t }}</span>
            <button type="button" class="btn btn-sm" (click)="load()">{{ 'Try again' | t }}</button>
          </div>
        }
        @if (asked(); as name) {
          <p class="alert alert-ok" role="status">
            {{ 'The server removes {name} within a minute.' | t: { name } }}
          </p>
        }
        @if (runner.problem(); as problem) {
          @if (!removing()) {
            <p class="alert" role="alert">{{ problem | t }}</p>
          }
        }
        @if (shown().length) {
          <ul class="card m-0 flex list-none flex-col p-0">
            @for (c of shown(); track c.name) {
              <li
                class="flex flex-wrap items-center justify-between gap-3 border-t border-line2 px-[18px] py-3 first:border-t-0"
              >
                <div class="min-w-0">
                  <div class="truncate font-mono text-[12.5px] text-fg">{{ c.name }}</div>
                  <div class="mt-0.5 text-[11.5px] text-dim">
                    {{
                      'application {app} · release {release} · unmatched since {since}'
                        | t
                          : {
                              app: c.application.name,
                              release: c.release,
                              since: (c.observedAt | localDate),
                            }
                    }}
                  </div>
                </div>
                <div class="flex items-center gap-4">
                  <span
                    class="flex items-center gap-[7px] text-[12.5px]"
                    [style.color]="color(c.state)"
                    ><span class="dot" [style.background]="color(c.state)"></span
                    >{{ c.state | t }}</span
                  >
                  <button
                    type="button"
                    class="btn btn-sm"
                    [disabled]="runner.busy()"
                    [attr.aria-label]="'Remove {name}' | t: { name: c.name }"
                    (click)="start(c)"
                  >
                    {{ 'Remove' | t }}
                  </button>
                </div>
              </li>
            }
          </ul>
        }
      </section>
    }

    @if (removing(); as c) {
      <sk-confirm-by-name
        [heading]="i18n.t('Remove {name}', { name: c.name })"
        [resourceName]="c.name"
        [fieldLabel]="i18n.t('Container name')"
        [actionLabel]="i18n.t('Remove the container')"
        [busyLabel]="i18n.t('Removing…')"
        [keepLabel]="i18n.t('Keep it')"
        [typeLabel]="i18n.t('This cannot be undone. Type its name to confirm:')"
        [busy]="runner.busy()"
        [blocked]="!!runner.cooldown()"
        (confirmed)="remove(c, $event)"
        (cancelled)="keep()"
      >
        {{
          'The server stops and removes this container of {app}. Its volumes stay.'
            | t: { app: c.application.name }
        }}
      </sk-confirm-by-name>
    }
  `,
})
export class UntrackedContainers {
  private readonly api = inject(FleetApi);
  protected readonly runner = inject(MutationRunner);
  protected readonly i18n = inject(I18n);

  readonly organizationId = input.required<string>();
  readonly nodeId = input.required<string>();

  protected readonly containers = signal<readonly UntrackedContainer[]>([]);
  protected readonly removing = signal<UntrackedContainer | null>(null);
  /** The container whose removal was asked last, until another is chosen. */
  protected readonly asked = signal<string | null>(null);
  /** The last read failed: what was read before stays, with a way to read again. */
  protected readonly unread = signal(false);
  /** The list, without the container whose removal was just asked: the server reports it gone soon. */
  protected readonly shown = computed(() =>
    this.containers().filter((container) => container.name !== this.asked()),
  );
  private revision = 0;

  constructor() {
    effect(() => {
      this.organizationId();
      this.nodeId();
      untracked(() => {
        this.containers.set([]);
        this.unread.set(false);
        this.removing.set(null);
        this.asked.set(null);
        this.runner.reset();
        void this.load();
      });
    });
  }

  /** Reads the list; a failed read keeps what is shown, and a stale one is dropped. */
  async load(): Promise<void> {
    const revision = ++this.revision;
    const organizationId = this.organizationId();
    const nodeId = this.nodeId();
    try {
      const containers = await this.api.untrackedContainers(organizationId, nodeId);
      if (revision !== this.revision) return;
      this.containers.set(containers);
      this.unread.set(false);
    } catch {
      // A container left behind must not vanish from view: the section says it could not read.
      if (revision === this.revision) this.unread.set(true);
    }
  }

  protected color(state: string): string {
    return STATE_COLORS[state] ?? GREY;
  }

  protected start(container: UntrackedContainer): void {
    if (this.runner.busy()) return;
    this.runner.reset();
    this.asked.set(null);
    this.removing.set(container);
  }

  protected keep(): void {
    this.removing.set(null);
    this.runner.reset();
  }

  protected async remove(container: UntrackedContainer, typed: string): Promise<void> {
    const organizationId = this.organizationId();
    const nodeId = this.nodeId();
    const outcome = await this.runner.run({ untracked: nodeId, name: container.name }, async () => {
      const confirmation = await this.api.confirmContainerRemoval(
        organizationId,
        nodeId,
        container.name,
        typed,
      );
      await this.api.removeUntrackedContainer(organizationId, nodeId, container.name, confirmation);
    });
    if (organizationId !== this.organizationId() || nodeId !== this.nodeId()) return;
    if (!outcome.ok) return;
    this.removing.set(null);
    this.asked.set(container.name);
    await this.load();
  }
}
