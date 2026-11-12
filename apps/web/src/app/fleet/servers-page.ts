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
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';

import { ageSeconds, bytes, nodeStatus, percent } from '../dashboard/format';
import { MutationRunner } from '../identity/mutation-runner';
import { PrivateClipboard } from '../identity/private-clipboard';
import { I18n, T } from '../ui/i18n';
import { Collection } from '../workspace/collection';
import { ConfirmByName } from '../workspace/confirm-by-name';
import { recoverOnEdit } from '../workspace/form-recovery';
import { required } from '../workspace/validators';

import { FleetApi, type FleetNode, type JoinToken } from './fleet-api';
import { PublicAddressesEditor } from './public-addresses-editor';

/** The agent configuration for a new server (deploy/agent/agent.example.yaml). */
export function agentConfig(token: JoinToken): string {
  return [
    'control_plane:',
    `  address: ${token.gatewayAddress}`,
    `  ca_fingerprint: ${token.caFingerprint}`,
    '  join_token_file: /etc/shipkeep/join-token',
    '',
  ].join('\n');
}

const COLUMNS =
  'grid-cols-[minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(130px,1.4fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_84px]';

/**
 * 03 Servers: status of every agent, the public addresses domains are checked against, adding one
 * with a join token, confirmed removal.
 */
@Component({
  selector: 'sk-servers-page',
  imports: [ConfirmByName, PublicAddressesEditor, ReactiveFormsModule, T],
  providers: [MutationRunner, PrivateClipboard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1 class="page-title">{{ 'Servers' | t }}</h1>
          <div class="page-sub">
            {{
              'Servers run the agent and host your applications. None accepts connections from the panel.'
                | t
            }}
          </div>
        </div>
      </div>

      @if (runner.problem(); as problem) {
        <div class="alert" role="alert">{{ problem | t }}</div>
      }

      <div
        class="card overflow-x-auto"
        role="region"
        [attr.aria-label]="'Servers' | t"
        tabindex="0"
      >
        <div class="min-w-[1000px]">
          <div
            [class]="
              columns + ' grid gap-3 border-b border-line px-5 py-2.5 text-[11.5px] text-dim2'
            "
          >
            <span>{{ 'Name' | t }}</span
            ><span>{{ 'State' | t }}</span
            ><span>{{ 'Labels' | t }}</span
            ><span>{{ 'Capacity' | t }}</span
            ><span>{{ 'Public address' | t }}</span
            ><span>{{ 'System' | t }}</span
            ><span>{{ 'Lease' | t }}</span
            ><span></span>
          </div>
          @switch (nodes.state()) {
            @case ('loading') {
              <p role="status" class="px-5 py-4 text-[13px] text-mute2">{{ 'Loading…' | t }}</p>
            }
            @case ('failed') {
              <p role="alert" class="px-5 py-4 text-[13px] text-rose">{{ nodes.problem() | t }}</p>
            }
            @default {
              @for (n of rows(); track n.node.id) {
                <div
                  [class]="
                    columns +
                    ' grid items-center gap-3 border-b border-line2 px-5 py-[13px] text-[13px]'
                  "
                  [style.background]="
                    removing()?.id === n.node.id ? 'oklch(0.68 0.17 25 / 0.06)' : null
                  "
                >
                  <div class="min-w-0">
                    <div class="truncate font-mono text-[12.5px]">{{ n.node.name }}</div>
                    <div class="mt-0.5 truncate text-[11px] text-dim">{{ n.agent }}</div>
                  </div>
                  <div>
                    <div
                      class="flex items-center gap-[7px] text-[12.5px]"
                      [style.color]="n.status.color"
                    >
                      <span class="dot" [style.background]="n.status.color"></span
                      >{{ n.status.label | t }}
                    </div>
                    <div class="mt-0.5 text-[11px] text-dim">
                      @if (n.beat !== null) {
                        {{ '{s} s ago' | t: { s: n.beat } }}
                      } @else {
                        {{ 'never' | t }}
                      }
                    </div>
                  </div>
                  <span class="truncate text-[12px] text-fg3">{{ n.labels || '—' }}</span>
                  <div class="flex flex-col gap-[5px]">
                    <div class="flex flex-col gap-[3px] text-[11px] text-mute2">
                      <span class="whitespace-nowrap">{{ n.spec || '—' }}</span>
                    </div>
                    <div class="flex flex-col gap-[3px] text-[11px] text-mute2">
                      <span class="whitespace-nowrap"
                        >{{ 'Disk' | t }} · {{ n.disk === null ? '—' : n.disk + ' %' }}</span
                      >
                      <div class="bar">
                        <span class="bg-mute2" [style.width.%]="n.disk ?? 0"></span>
                      </div>
                    </div>
                  </div>
                  <div class="flex min-w-0 flex-col items-start gap-1">
                    @if (n.node.publicAddresses.length) {
                      <span class="max-w-full truncate font-mono text-[11.5px] text-fg3">{{
                        n.node.publicAddresses[0]
                      }}</span>
                      @if (n.node.publicAddresses.length > 1) {
                        <span class="text-[11px] text-dim">{{
                          '+{n} more' | t: { n: n.node.publicAddresses.length - 1 }
                        }}</span>
                      }
                    } @else {
                      <span class="text-[11.5px] text-dim">{{ 'not set' | t }}</span>
                    }
                    <button
                      type="button"
                      class="btn btn-xs"
                      [disabled]="busy()"
                      [attr.aria-label]="
                        'Edit the public addresses of {name}' | t: { name: n.node.name }
                      "
                      (click)="edit(n.node)"
                    >
                      {{ (n.node.publicAddresses.length ? 'Change' : 'Set') | t }}
                    </button>
                  </div>
                  <span class="truncate font-mono text-[11.5px] text-fg3">{{ n.os || '—' }}</span>
                  <span class="text-[12px] text-fg3">{{
                    'epoch {n}' | t: { n: n.node.leaseEpoch }
                  }}</span>
                  <button
                    type="button"
                    class="btn btn-sm justify-self-end px-3 py-1.5"
                    [disabled]="busy()"
                    [attr.aria-label]="'Remove {name}' | t: { name: n.node.name }"
                    (click)="startRemoval(n.node)"
                  >
                    {{ 'Remove' | t }}
                  </button>
                </div>
              } @empty {
                <p class="px-5 py-6 text-[13px] text-mute2">
                  {{ 'No server yet. Add one below.' | t }}
                </p>
              }
            }
          }
        </div>
      </div>

      @if (removing(); as node) {
        <sk-confirm-by-name
          [heading]="i18n.t('Remove {name}', { name: node.name })"
          [resourceName]="node.name"
          [fieldLabel]="i18n.t('Server name')"
          [actionLabel]="i18n.t('Remove the server')"
          [busyLabel]="i18n.t('Removing…')"
          [keepLabel]="i18n.t('Keep it')"
          [typeLabel]="i18n.t('This cannot be undone. Type its name to confirm:')"
          [busy]="runner.busy()"
          [blocked]="!!runner.cooldown()"
          (confirmed)="remove(node, $event)"
          (cancelled)="keep()"
        >
          {{ 'Its certificates are revoked and its agent is disconnected.' | t }}
        </sk-confirm-by-name>
      }

      @if (editing(); as node) {
        <sk-public-addresses-editor
          [organizationId]="organizationId()"
          [node]="node"
          (saved)="saved()"
          (cancelled)="editing.set(null)"
          (saving)="saving.set($event)"
        />
      }

      <div class="flex flex-wrap items-start gap-3.5">
        <section
          class="card flex min-w-0 flex-[1_1_420px] flex-col gap-3.5 p-5"
          aria-labelledby="add-title"
        >
          <h2 id="add-title" class="text-[15px] font-medium">{{ 'Add a server' | t }}</h2>
          @if (issued(); as token) {
            <div class="flex flex-col gap-3">
              <div class="text-[13px] leading-[1.55] text-fg3">
                {{ 'This token is shown once and expires in' | t }}
                <span class="font-mono text-fg">{{ left() }}</span
                >.
                {{ 'Keep it out of your shell history.' | t }}
              </div>
              <div
                class="flex items-center gap-2 rounded-lg border border-ctl bg-black py-2 pr-2 pl-3"
              >
                <label for="join-token" class="sr-only">{{ 'Join token' | t }}</label>
                <input
                  id="join-token"
                  class="min-w-0 flex-1 truncate bg-transparent font-mono text-[12.5px] text-fg outline-none"
                  readonly
                  [value]="token.token"
                  autocomplete="off"
                  spellcheck="false"
                />
                <button
                  type="button"
                  class="btn btn-sm rounded-md px-2.5 py-1"
                  (click)="clipboard.copy(token.token)"
                >
                  {{ 'Copy' | t }}
                </button>
              </div>
              @if (clipboard.message(); as message) {
                <p class="text-[12px] text-mute" role="status">{{ message | t }}</p>
              }
              <ol class="m-0 flex list-none flex-col gap-2.5 p-0 text-[12.5px] text-fg3">
                <li>
                  {{ '1. Save the token in /etc/shipkeep/join-token, readable by root only.' | t }}
                </li>
                <li>
                  <pre class="code-box">
sudo install -d -m 0700 /etc/shipkeep
sudo install -m 0600 /dev/stdin /etc/shipkeep/join-token</pre>
                </li>
                <li>{{ '2. Write /etc/shipkeep/agent.yaml.' | t }}</li>
                <li>
                  <pre class="code-box" aria-label="agent.yaml">{{ config() }}</pre>
                </li>
                <li>
                  {{
                    '3. Start shipkeep-agent. It checks the fingerprint, enrolls, then deletes the token.'
                      | t
                  }}
                </li>
              </ol>
              <div>
                <button class="btn btn-sm" type="button" (click)="issued.set(null)">
                  {{ 'Done' | t }}
                </button>
              </div>
            </div>
          } @else {
            <form [formGroup]="join" (ngSubmit)="issue()" class="flex flex-col gap-3">
              <p class="text-[13px] leading-[1.55] text-mute">
                {{
                  'Your password is required: the token lets a machine join this organization.' | t
                }}
              </p>
              <div class="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2.5">
                <div class="flex flex-col gap-1.5">
                  <label for="join-password" class="text-[12px] text-fg3">{{
                    'Password' | t
                  }}</label>
                  <input
                    id="join-password"
                    class="input"
                    type="password"
                    formControlName="password"
                    autocomplete="current-password"
                  />
                </div>
                <div class="flex flex-col gap-1.5">
                  <label for="join-totp" class="text-[12px] text-fg3">{{
                    'Authentication code' | t
                  }}</label>
                  <input
                    id="join-totp"
                    class="input font-mono"
                    formControlName="totp"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    [placeholder]="'if enabled' | t"
                  />
                </div>
              </div>
              <div>
                <button
                  class="btn btn-primary"
                  type="submit"
                  [disabled]="runner.busy() || !!runner.cooldown() || join.invalid"
                >
                  {{ (runner.busy() ? 'Creating…' : 'Create a join token') | t }}
                </button>
              </div>
            </form>
          }
        </section>
        <section
          class="card flex min-w-0 flex-[1_1_360px] flex-col gap-3 p-5"
          aria-labelledby="failover-title"
        >
          <h2 id="failover-title" class="text-[14px] font-medium">{{ 'If a server fails' | t }}</h2>
          @for (f of failover; track f.t) {
            <div class="grid grid-cols-[52px_minmax(0,1fr)] gap-3 text-[12.5px] leading-normal">
              <span class="font-mono text-fg">{{ f.t | t }}</span
              ><span class="text-pretty text-fg3">{{ f.d | t }}</span>
            </div>
          }
        </section>
      </div>
    </div>
  `,
})
export class ServersPage {
  private readonly api = inject(FleetApi);
  protected readonly i18n = inject(I18n);
  protected readonly runner = inject(MutationRunner);
  protected readonly clipboard = inject(PrivateClipboard);
  protected readonly columns = COLUMNS;
  readonly organizationId = input.required<string>();
  protected readonly nodes = new Collection<FleetNode>(() => this.api.nodes(this.organizationId()));
  protected readonly issued = signal<JoinToken | null>(null);
  protected readonly config = computed(() => {
    const token = this.issued();
    return token ? agentConfig(token) : '';
  });
  protected readonly removing = signal<FleetNode | null>(null);
  protected readonly editing = signal<FleetNode | null>(null);
  /** The address editor's save in flight; with the page's own runner, it holds row actions. */
  protected readonly saving = signal(false);
  protected readonly busy = computed(() => this.runner.busy() || this.saving());
  protected readonly join = new FormGroup({
    password: new FormControl('', { nonNullable: true, validators: [required] }),
    totp: new FormControl('', { nonNullable: true }),
  });
  private readonly now = signal(Date.now());
  protected readonly left = computed(() => {
    const token = this.issued();
    if (!token) return '';
    const seconds = Math.max(0, Math.floor((Date.parse(token.expiresAt) - this.now()) / 1000));
    return `${String(Math.floor(seconds / 60))} min ${String(seconds % 60).padStart(2, '0')} s`;
  });
  protected readonly rows = computed(() =>
    this.nodes.items().map((node) => {
      const facts = node.facts as Record<string, unknown>;
      const text = (key: string) => {
        const value = facts[key];
        return typeof value === 'string' ? value : '';
      };
      const disk = typeof facts['disk_bytes'] === 'number' ? facts['disk_bytes'] : 0;
      const free = typeof facts['disk_free_bytes'] === 'number' ? facts['disk_free_bytes'] : 0;
      const cpu = typeof facts['cpu_count'] === 'number' ? facts['cpu_count'] : null;
      return {
        node,
        status: nodeStatus(node.status),
        beat: ageSeconds(node.lastHeartbeatAt, this.now()),
        agent: [text('agent_version') && `agent ${text('agent_version')}`, text('hostname')]
          .filter(Boolean)
          .join(' · '),
        labels: Object.entries(node.labels as Record<string, unknown>)
          .map(
            ([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`,
          )
          .join(', '),
        spec: [cpu ? `${String(cpu)} CPU` : '', bytes(facts['memory_bytes']) ?? '']
          .filter(Boolean)
          .join(' · '),
        disk: disk ? percent(disk - free, disk) : null,
        os: [text('os'), text('os_version')].filter(Boolean).join(' '),
      };
    }),
  );
  protected readonly failover = [
    { t: '15 s', d: 'Without a heartbeat, the server becomes suspect.' },
    { t: '60 s', d: 'The lease expires: the server is down.' },
    {
      t: '—',
      d: 'Moving stateless replicas to healthy servers arrives with automatic failover (M4.5).',
    },
  ];

  constructor() {
    recoverOnEdit(this.join, this.runner);
    effect(() => {
      this.organizationId();
      void this.nodes.refresh();
    });
    const timer = setInterval(() => {
      this.now.set(Date.now());
    }, 1000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
    });
  }

  protected async issue(): Promise<void> {
    const { password, totp } = this.join.getRawValue();
    const code = totp.trim();
    const outcome = await this.runner.run({ joinToken: this.organizationId() }, () =>
      this.api.issueJoinToken(this.organizationId(), { password, ...(code ? { totp: code } : {}) }),
    );
    this.join.reset();
    if (outcome.ok) this.issued.set(outcome.value);
  }

  /** One panel at a time: editing addresses and removing a server never overlap. */
  protected edit(node: FleetNode): void {
    // A removal or a save in flight keeps its runner until it finishes and refreshes the list.
    if (this.busy()) return;
    this.keep();
    this.editing.set(node);
  }

  protected startRemoval(node: FleetNode): void {
    if (this.busy()) return;
    this.editing.set(null);
    this.removing.set(node);
  }

  protected async saved(): Promise<void> {
    this.saving.set(false);
    this.editing.set(null);
    await this.nodes.refresh();
  }

  protected keep(): void {
    this.removing.set(null);
    this.runner.reset();
  }

  protected async remove(node: FleetNode, name: string): Promise<void> {
    const outcome = await this.runner.run({ remove: node.id, name }, async () => {
      const confirmation = await this.api.confirmRemoval(this.organizationId(), node, name);
      await this.api.removeNode(this.organizationId(), node.id, confirmation);
    });
    if (!outcome.ok) return;
    this.removing.set(null);
    await this.nodes.refresh();
  }
}
