import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';

import { shortDate } from '../dashboard/format';
import { IdentityRequestError } from '../identity/identity-api';
import { MutationRunner } from '../identity/mutation-runner';
import { type BrandName } from '../shell/brands';
import { Icon } from '../shell/icon';
import { Brand } from '../ui/brand';
import { T } from '../ui/i18n';
import { recoverOnEdit } from './form-recovery';
import { required } from './validators';
import { type RegistryCredentials as Stored, WorkspaceApi } from './workspace-api';

/** A host and an optional port, as an image reference names its registry. The server decides. */
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?$/;
/** What the server answers, said in words that tell the administrator what to do. */
const REFUSALS: Readonly<Record<string, string>> = {
  invalid_registry_server:
    'This is not a registry host. Write a host and an optional port, like ghcr.io or registry.example.com:5000.',
  registry_limit_reached:
    'This organization already stores credentials for 100 registries. Remove one first.',
  registry_credentials_changed:
    'These credentials changed in the meantime. The list is up to date: try again.',
};
const LOGOS: Readonly<Record<string, BrandName>> = { 'docker.io': 'docker', 'ghcr.io': 'github' };

/** What the last finished read of the list found, and for which organization. */
interface Loaded {
  readonly organizationId: string;
  /** The server hides the list from who does not administer the organization. */
  readonly denied: boolean;
  readonly items: readonly Stored[];
}

/**
 * Registry credentials of an organization (ADR 0019): the hosts and accounts are listed, a
 * password is typed to store or replace them and is never shown again.
 */
@Component({
  selector: 'sk-registry-credentials',
  imports: [Brand, Icon, ReactiveFormsModule, T],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <p class="sec-desc -mt-2">
      {{
        'Deployments of this organization pull private images with the credentials stored for the registry of the image. A password is encrypted and never shown again: it can only be replaced.'
          | t
      }}
    </p>
    @if (denied()) {
      <div class="note">
        <sk-icon name="lock" class="text-mute" />
        <span>{{
          'Only owners and administrators of the organization manage registry credentials.' | t
        }}</span>
      </div>
    } @else {
      @switch (status()) {
        @case ('failed') {
          <div class="alert" role="alert">{{ failure() | t }}</div>
        }
        @default {
          <div class="card overflow-x-auto">
            <div class="sm:min-w-[560px]">
              <div class="grid-table th px-[18px] py-[11px] max-sm:hidden" [class]="columns">
                <span>{{ 'Registry' | t }}</span>
                <span>{{ 'Account' | t }}</span>
                <span>{{ 'Updated' | t }}</span>
                <span class="sr-only">{{ 'Actions' | t }}</span>
              </div>
              @for (row of rows(); track row.id) {
                <div
                  class="grid-table border-t border-line2 px-[18px] py-3 text-[12.5px] max-sm:gap-1.5 max-sm:first:border-t-0"
                  [class]="columns"
                  [attr.aria-label]="row.server"
                  role="group"
                >
                  <span class="flex min-w-0 items-center gap-[7px] font-mono text-[#C8C8CF]">
                    @if (logo(row.server); as mark) {
                      <sk-brand [name]="mark" class="size-[15px] text-fg3" />
                    } @else {
                      <sk-icon name="lock" class="text-[15px] text-mute" />
                    }
                    <span class="truncate">{{ row.server }}</span>
                  </span>
                  <span class="truncate text-[#C8C8CF]">{{ row.username }}</span>
                  <span class="truncate text-[#7E7E87]">{{
                    '{date} · version {n}' | t: { date: date(row.updatedAt), n: row.version }
                  }}</span>
                  <span class="flex justify-end gap-2 max-sm:mt-1.5 max-sm:justify-start">
                    <button
                      class="btn btn-sm"
                      type="button"
                      [disabled]="runner.busy() || !usable()"
                      [attr.aria-label]="
                        'Replace the credentials of {name}' | t: { name: row.server }
                      "
                      (click)="edit(row)"
                    >
                      {{ 'Replace' | t }}
                    </button>
                    <button
                      class="btn btn-sm btn-danger"
                      type="button"
                      [disabled]="runner.busy() || !usable()"
                      [attr.aria-label]="
                        'Remove the credentials of {name}' | t: { name: row.server }
                      "
                      (click)="askRemoval(row)"
                    >
                      {{ 'Remove' | t }}
                    </button>
                  </span>
                </div>
              } @empty {
                <div class="border-t border-line2 px-[18px] py-5 text-[12.5px] text-mute2">
                  {{ (usable() ? 'No registry yet. Public images need none.' : 'Loading…') | t }}
                </div>
              }
              <div class="border-t border-line2 px-[18px] py-3">
                <button
                  type="button"
                  class="btn btn-sm"
                  [disabled]="runner.busy() || !usable()"
                  (click)="add()"
                >
                  <sk-icon name="plus" />{{ 'Add a registry' | t }}
                </button>
              </div>
            </div>
          </div>
        }
      }
      @if (problem(); as text) {
        <div class="alert max-w-[640px]" role="alert">{{ text | t }}</div>
      }
      @if (removing(); as target) {
        <section
          class="flex max-w-[640px] flex-col gap-3 rounded-[14px] border border-[oklch(0.68_0.17_25/0.5)] bg-black p-5"
          aria-labelledby="registry-removal-title"
        >
          <h2 id="registry-removal-title" class="text-[15px] font-medium">
            {{ 'Remove the credentials of {name}' | t: { name: target.server } }}
          </h2>
          <p class="text-[13.5px] leading-[1.55] text-fg3">
            {{
              'The next deployment that must pull a private image from this registry will fail. Containers that already run are not affected.'
                | t
            }}
          </p>
          <div class="flex flex-wrap gap-2.5">
            <button class="btn btn-danger" type="button" [disabled]="busy()" (click)="remove()">
              {{ (runner.busy() ? 'Removing…' : 'Remove them') | t }}
            </button>
            <button
              class="btn btn-sm"
              type="button"
              [disabled]="runner.busy()"
              (click)="removing.set(null)"
            >
              {{ 'Keep them' | t }}
            </button>
          </div>
        </section>
      }
      @if (editing(); as target) {
        <form
          [formGroup]="form"
          (ngSubmit)="save()"
          class="card flex max-w-[640px] flex-col gap-3.5 p-5"
          aria-labelledby="registry-form-title"
        >
          <h2 id="registry-form-title" class="text-[15px] font-medium">
            {{
              target.server
                ? ('Replace the credentials of {name}' | t: { name: target.server })
                : ('Add a registry' | t)
            }}
          </h2>
          <div class="flex flex-col gap-1.5">
            <label for="registry-server" class="text-[12px] text-fg3">{{
              'Registry host' | t
            }}</label>
            <input
              id="registry-server"
              class="input font-mono"
              formControlName="server"
              placeholder="ghcr.io"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              aria-describedby="registry-server-hint"
              [readOnly]="!!target.server"
              [attr.aria-invalid]="form.controls.server.touched && form.controls.server.invalid"
            />
            <span id="registry-server-hint" class="field-hint">{{
              'As the image names it, with its port if it has one. Docker Hub is docker.io.' | t
            }}</span>
          </div>
          <div class="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2.5">
            <div class="flex flex-col gap-1.5">
              <label for="registry-username" class="text-[12px] text-fg3">{{
                'User name' | t
              }}</label>
              <input
                id="registry-username"
                class="input"
                formControlName="username"
                autocomplete="off"
                autocapitalize="none"
                spellcheck="false"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label for="registry-password" class="text-[12px] text-fg3">{{
                'Password or access token' | t
              }}</label>
              <input
                id="registry-password"
                class="input"
                type="password"
                formControlName="password"
                autocomplete="new-password"
              />
            </div>
          </div>
          <span class="field-hint -mt-1">{{
            'Use an account or a token that can only read the images this organization runs.' | t
          }}</span>
          <div class="flex flex-wrap gap-2.5">
            <button class="btn btn-primary" type="submit" [disabled]="busy() || form.invalid">
              {{ (runner.busy() ? 'Saving…' : 'Save the credentials') | t }}
            </button>
            <button class="btn" type="button" [disabled]="runner.busy()" (click)="close()">
              {{ 'Cancel' | t }}
            </button>
          </div>
        </form>
      }
    }
  `,
})
export class RegistryCredentials {
  private readonly api = inject(WorkspaceApi);
  protected readonly runner = inject(MutationRunner);
  readonly organizationId = input.required<string>();
  /**
   * Registry, account, last change, and the two actions of a row. The last column has a fixed
   * width so that the header lines up with the rows; on a phone a row is a stack, with its
   * actions in view instead of behind a sideways scroll.
   */
  protected readonly columns =
    'sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_176px]' as const;
  #revision = 0;
  private readonly loaded = signal<Loaded | null>(null);
  protected readonly status = signal<'loading' | 'ready' | 'failed'>('loading');
  protected readonly failure = signal<string | null>(null);
  /**
   * Only what was loaded for the organization on screen. The page stays open when another
   * organization is chosen: rows of the previous one must never be shown, replaced or removed
   * under the new one.
   */
  private readonly current = computed(() => {
    const loaded = this.loaded();
    return loaded?.organizationId === this.organizationId() ? loaded : null;
  });
  protected readonly rows = computed(() => this.current()?.items ?? []);
  protected readonly denied = computed(() => this.current()?.denied ?? false);
  /** The list on screen belongs to this organization and is not being read again. */
  protected readonly usable = computed(() => this.status() === 'ready' && !!this.current());
  /** The form is open: for a new registry, or to replace the credentials of `server`. */
  protected readonly editing = signal<{ readonly server: string | null } | null>(null);
  protected readonly removing = signal<Stored | null>(null);
  private readonly refusal = signal<string | null>(null);
  protected readonly problem = computed(() => this.refusal() ?? this.runner.problem());
  protected readonly busy = computed(() => this.runner.busy() || !!this.runner.cooldown());
  protected readonly form = new FormGroup({
    server: new FormControl('', {
      nonNullable: true,
      validators: [required, Validators.maxLength(255), Validators.pattern(HOST)],
    }),
    username: new FormControl('', {
      nonNullable: true,
      validators: [required, Validators.maxLength(256), Validators.pattern(/^[^:]+$/)],
    }),
    password: new FormControl('', {
      nonNullable: true,
      validators: [required, Validators.maxLength(4096)],
    }),
  });
  protected readonly date = shortDate;

  constructor() {
    recoverOnEdit(this.form, this.runner);
    effect(() => {
      this.organizationId();
      this.close();
      this.removing.set(null);
      void this.refresh();
    });
  }

  protected logo(server: string): BrandName | undefined {
    return LOGOS[server];
  }

  protected add(): void {
    this.open(null, '');
  }
  protected edit(row: Stored): void {
    this.open(row.server, row.username);
  }
  protected askRemoval(row: Stored): void {
    this.again();
    this.close();
    this.removing.set(row);
  }
  protected close(): void {
    this.editing.set(null);
    // The password does not stay in a closed form.
    this.form.reset();
  }

  protected async save(): Promise<void> {
    const { server, username, password } = this.form.getRawValue();
    // The password never enters the retry fingerprint: only the registry and the account do.
    const outcome = await this.run({ set: server, username }, () =>
      this.api.setRegistry(this.organizationId(), { server, username, password }),
    );
    this.form.controls.password.reset();
    if (!outcome) return;
    this.close();
    await this.refresh();
  }

  protected async remove(): Promise<void> {
    const target = this.removing();
    if (!target) return;
    const done = await this.run({ remove: target.id }, () =>
      this.api.removeRegistry(this.organizationId(), target.id),
    );
    if (done) this.removing.set(null);
    // After a refusal too: another administrator may have changed the list.
    await this.refresh();
  }

  private open(server: string | null, username: string): void {
    this.again();
    this.removing.set(null);
    this.form.reset({ server: server ?? '', username, password: '' });
    this.editing.set({ server });
  }

  /** A new attempt starts over: a refusal of the previous one must not block it. */
  private again(): void {
    this.refusal.set(null);
    if (this.runner.restartRequired()) this.runner.reset();
  }

  /** Runs a change and keeps the server's reason when it has one this screen can explain. */
  private async run(fingerprint: unknown, change: () => Promise<unknown>): Promise<boolean> {
    // A conflict blocks the runner until it restarts; asking again is that restart. A wait the
    // server asked for still applies.
    this.again();
    const outcome = await this.runner.run(fingerprint, async () => {
      try {
        await change();
      } catch (error: unknown) {
        if (error instanceof IdentityRequestError)
          this.refusal.set(REFUSALS[error.problem?.code ?? ''] ?? null);
        throw error;
      }
    });
    return outcome.ok;
  }

  /**
   * Reads the list. The rows, the refusal and the organization they belong to are committed
   * together, and only by the latest request: an answer that arrives late, for an organization
   * that is no longer on screen, changes nothing.
   */
  private async refresh(): Promise<void> {
    const organizationId = this.organizationId();
    const revision = ++this.#revision;
    this.status.set('loading');
    try {
      const items = await this.api.registries(organizationId);
      if (revision !== this.#revision) return;
      this.loaded.set({ organizationId, denied: false, items });
    } catch (error: unknown) {
      if (revision !== this.#revision) return;
      // The list answers 404 to who does not administer the organization: that is not a failure.
      if (!(error instanceof IdentityRequestError) || ![403, 404].includes(error.status)) {
        this.status.set('failed');
        this.failure.set(
          error instanceof IdentityRequestError ? error.message : 'This list could not be loaded.',
        );
        return;
      }
      this.loaded.set({ organizationId, denied: true, items: [] });
    }
    this.status.set('ready');
    this.failure.set(null);
  }
}
