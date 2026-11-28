import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';

import { MutationRunner } from '../identity/mutation-runner';
import { PrivateClipboard } from '../identity/private-clipboard';
import { LocalDate, T } from '../ui/i18n';
import { required } from '../workspace/validators';

import { FleetApi, type FleetNode, type NodeReadoption } from './fleet-api';

/** What the server prints for its own certificate: the serial the list shows, `serial=…`. */
const SERIAL_COMMAND =
  'sudo python3 -c \'import json; print(json.load(open("/var/lib/shipkeep/credentials.json"))["certificate"])\' | openssl x509 -noout -serial | tr A-F a-f';

/**
 * Servers waiting to be re-adopted (#487, SPEC 3.1). After a restore from a backup older than a
 * server's last certificate renewal, its agent presents a certificate this installation never
 * registered, and is refused. An administrator who recognizes the server checks the certificate's
 * serial on it and confirms with their password: that same server comes back, with its
 * applications. The confirmation names the certificate reviewed (#545): if another one replaced
 * it meanwhile, nothing is adopted and the form closes. Hidden while nothing waits.
 */
@Component({
  selector: 'sk-node-readoptions',
  imports: [LocalDate, ReactiveFormsModule, T],
  providers: [MutationRunner, PrivateClipboard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (rows().length || readopted() || unread()) {
      <section
        class="card flex flex-col gap-3 px-5 py-4"
        aria-labelledby="readoptions-title"
        [attr.aria-busy]="runner.busy()"
      >
        <div class="flex flex-col gap-1">
          <h2 id="readoptions-title" class="text-[14px] font-medium">
            {{ 'Servers to re-adopt' | t }}
          </h2>
          <p class="text-[12.5px] leading-[1.55] text-pretty text-fg3">
            {{
              'These servers present a certificate this installation does not know, as after a restore from a backup older than their last certificate renewal. Their applications keep running. Re-adopt a server you recognize: it connects again within 5 minutes, or, with an agent of 0.1.0-alpha.7 or earlier, once its agent is restarted (sudo systemctl restart shipkeep-agent).'
                | t
            }}
          </p>
        </div>

        @if (replaced(); as name) {
          <p class="alert" role="alert">
            {{
              'The certificate waiting for {name} changed before it was re-adopted, and nothing was re-adopted. Check the new serial on the server before you re-adopt it.'
                | t: { name }
            }}
          </p>
        }
        @if (readopted(); as name) {
          <p class="alert alert-ok" role="status">
            {{
              '{name} is re-adopted: it connects again within 5 minutes, or once its agent is restarted if it runs 0.1.0-alpha.7 or earlier.'
                | t: { name }
            }}
          </p>
        }
        @if (runner.problem(); as problem) {
          <div class="alert flex-col items-start gap-2" role="alert">
            <span>{{ problem | t }}</span>
            @if (runner.restartRequired()) {
              <button type="button" class="btn btn-sm" (click)="startAgain()">
                {{ 'Start again' | t }}
              </button>
            }
          </div>
        }
        @if (unread()) {
          <div class="alert flex-wrap items-center justify-between" role="alert">
            <span>{{ 'The servers to re-adopt could not be read.' | t }}</span>
            <button type="button" class="btn btn-sm" (click)="load()">{{ 'Try again' | t }}</button>
          </div>
        }

        @if (rows().length) {
          <ul class="m-0 flex list-none flex-col p-0">
            @for (r of rows(); track r.nodeId) {
              <li
                class="flex flex-col gap-3 border-t border-line2 py-3 first:border-t-0 first:pt-1"
              >
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div class="min-w-0">
                    <span class="font-mono text-[12.5px] text-fg">{{ r.name }}</span>
                    <div class="mt-0.5 text-[11px] text-dim">
                      {{
                        'refused since {since} · certificate valid until {until}'
                          | t
                            : {
                                since: (r.firstSeenAt | localDate),
                                until: (r.certificateNotAfter | localDate),
                              }
                      }}
                    </div>
                    <div class="mt-0.5 text-[11px] break-all text-dim">
                      {{ 'certificate' | t }}
                      <span class="font-mono text-fg3">{{ r.certificateSerial }}</span>
                    </div>
                  </div>
                  @if (open()?.nodeId !== r.nodeId) {
                    <button
                      type="button"
                      class="btn btn-sm"
                      [disabled]="runner.busy()"
                      [attr.aria-label]="'Re-adopt {name}' | t: { name: r.name }"
                      (click)="choose(r)"
                    >
                      {{ 'Re-adopt' | t }}
                    </button>
                  }
                </div>
                @if (open(); as reviewed) {
                  @if (reviewed.nodeId === r.nodeId) {
                    <form [formGroup]="proof" (ngSubmit)="readopt(r)" class="flex flex-col gap-3">
                      <div class="flex flex-col gap-1.5">
                        <p class="text-[12.5px] leading-[1.55] text-mute">
                          {{
                            'Check first that {name} holds this certificate: on that server, this command prints serial={serial}.'
                              | t: { name: r.name, serial: reviewed.certificateSerial }
                          }}
                        </p>
                        <pre
                          class="code-box"
                          tabindex="0"
                          [attr.aria-label]="'Command to read the serial' | t"
                          >{{ serialCommand }}</pre>
                        <div class="flex flex-wrap items-center gap-2.5">
                          <button class="btn btn-sm" type="button" (click)="copyCommand()">
                            {{ 'Copy the command' | t }}
                          </button>
                          @if (clipboard.message(); as message) {
                            <span class="text-[12px] text-mute" role="status">{{
                              (message.startsWith('Copied') ? 'Command copied.' : message) | t
                            }}</span>
                          }
                        </div>
                      </div>
                      <p class="text-[12.5px] leading-[1.55] text-mute">
                        {{
                          'Your password is required: {name} gets back what this organization lets a server do.'
                            | t: { name: r.name }
                        }}
                      </p>
                      <div class="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2.5">
                        <div class="flex flex-col gap-1.5">
                          <label for="readopt-password" class="text-[12px] text-fg3">{{
                            'Password' | t
                          }}</label>
                          <input
                            id="readopt-password"
                            class="input"
                            type="password"
                            formControlName="password"
                            autocomplete="current-password"
                          />
                        </div>
                        <div class="flex flex-col gap-1.5">
                          <label for="readopt-totp" class="text-[12px] text-fg3">{{
                            'Authentication code' | t
                          }}</label>
                          <input
                            id="readopt-totp"
                            class="input font-mono"
                            formControlName="totp"
                            inputmode="numeric"
                            autocomplete="one-time-code"
                            [placeholder]="'if enabled' | t"
                          />
                        </div>
                      </div>
                      <div class="flex flex-wrap gap-2">
                        <button
                          class="btn btn-primary btn-sm"
                          type="submit"
                          [disabled]="
                            runner.busy() ||
                            !!runner.cooldown() ||
                            runner.restartRequired() ||
                            proof.invalid
                          "
                        >
                          {{
                            (runner.busy() ? 'Re-adopting…' : 'Re-adopt {name}')
                              | t: { name: r.name }
                          }}
                        </button>
                        <button
                          class="btn btn-sm"
                          type="button"
                          [disabled]="runner.busy()"
                          (click)="close()"
                        >
                          {{ 'Cancel' | t }}
                        </button>
                      </div>
                    </form>
                  }
                }
              </li>
            }
          </ul>
        }
      </section>
    }
  `,
})
export class NodeReadoptions {
  private readonly api = inject(FleetApi);
  protected readonly runner = inject(MutationRunner);
  protected readonly clipboard = inject(PrivateClipboard);

  readonly organizationId = input.required<string>();
  /** The organization's servers, for their names. */
  readonly nodes = input<readonly FleetNode[]>([]);
  /** A server was re-adopted: its list row changes once its agent connects. */
  readonly changed = output();

  private readonly pending = signal<readonly NodeReadoption[]>([]);
  /** The server whose proof form is open, with the certificate shown when it was opened. */
  protected readonly open = signal<{
    readonly nodeId: string;
    readonly certificateSerial: string;
  } | null>(null);
  /** The name of the server whose waiting certificate changed while its form was open (#545). */
  protected readonly replaced = signal<string | null>(null);
  protected readonly serialCommand = SERIAL_COMMAND;
  /** The name of the server re-adopted last, until another one is chosen. */
  protected readonly readopted = signal<string | null>(null);
  /** The last read failed: what was read before stays, with a way to read again. */
  protected readonly unread = signal(false);
  private revision = 0;

  protected readonly proof = new FormGroup({
    password: new FormControl('', { nonNullable: true, validators: [required] }),
    totp: new FormControl('', { nonNullable: true }),
  });

  protected readonly rows = computed(() => {
    const names = new Map(this.nodes().map((node) => [node.id, node.name] as const));
    return this.pending().map((request) => ({
      ...request,
      name: names.get(request.nodeId) ?? request.nodeId,
    }));
  });

  constructor() {
    effect(() => {
      this.organizationId();
      untracked(() => {
        // Nothing of another organization's servers stays on screen.
        this.pending.set([]);
        this.unread.set(false);
        this.close();
        this.readopted.set(null);
        this.replaced.set(null);
        this.runner.reset();
        void this.load();
      });
    });
  }

  /** Reads the waiting certificates; a failed read hides nothing that was shown. */
  async load(): Promise<void> {
    const revision = ++this.revision;
    const organizationId = this.organizationId();
    try {
      const pending = await this.api.readoptions(organizationId);
      if (revision !== this.revision) return;
      // A server no longer waiting takes its open form with it: no password stays behind. One
      // whose certificate changed does too, and says so: the new one needs a review of its own.
      const open = this.open();
      const waiting = open && pending.find((request) => request.nodeId === open.nodeId);
      if (open && !waiting) this.close();
      if (open && waiting && waiting.certificateSerial !== open.certificateSerial) {
        this.close();
        this.runner.reset();
        this.replaced.set(
          this.rows().find((row) => row.nodeId === open.nodeId)?.name ?? open.nodeId,
        );
      }
      this.pending.set(pending);
      this.unread.set(false);
    } catch {
      // A server that waits must not vanish: the card says the list could not be read.
      if (revision === this.revision) this.unread.set(true);
    }
  }

  protected choose(request: NodeReadoption): void {
    if (this.runner.busy()) return;
    this.proof.reset();
    this.runner.reset();
    this.readopted.set(null);
    this.replaced.set(null);
    this.open.set({ nodeId: request.nodeId, certificateSerial: request.certificateSerial });
  }

  /** After a refusal that needs a fresh attempt: the form is emptied, and can be sent again. */
  protected startAgain(): void {
    this.proof.reset();
    this.runner.reset();
  }

  protected close(): void {
    this.proof.reset();
    this.clipboard.reset();
    this.open.set(null);
  }

  protected async copyCommand(): Promise<void> {
    await this.clipboard.copy(SERIAL_COMMAND);
  }

  protected async readopt(row: { readonly nodeId: string; readonly name: string }): Promise<void> {
    // The certificate the form was opened for, never one the list shows since.
    const reviewed = this.open();
    if (reviewed?.nodeId !== row.nodeId) return;
    const { password, totp } = this.proof.getRawValue();
    const code = totp.trim();
    const organizationId = this.organizationId();
    const outcome = await this.runner.run(
      { readopt: row.nodeId, certificateSerial: reviewed.certificateSerial },
      () =>
        this.api.readopt(organizationId, row.nodeId, {
          password,
          certificateSerial: reviewed.certificateSerial,
          ...(code ? { totp: code } : {}),
        }),
    );
    // The page changed organization meanwhile: what is typed there now is left alone.
    if (organizationId !== this.organizationId()) return;
    // A newer review may have taken the form meanwhile, as when the list showed another
    // certificate: the password typed there and its form are its own.
    const owned = this.open() === reviewed;
    if (owned) this.proof.reset();
    if (outcome.ok) {
      if (owned) this.open.set(null);
      this.readopted.set(row.name);
      this.changed.emit();
    }
    await this.load();
  }
}
