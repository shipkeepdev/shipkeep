import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { MutationRunner } from '../identity/mutation-runner';
import { PrivateClipboard } from '../identity/private-clipboard';
import { Collection } from '../workspace/collection';
import { required } from '../workspace/validators';

import { InstallCommand } from './install-command';

import { FleetApi, type FleetNode, type JoinToken } from './fleet-api';

/** Servers of an organization: status, adding one with a join token, confirmed removal. */
@Component({
  selector: 'sk-servers-page',
  imports: [ReactiveFormsModule, RouterLink],
  providers: [MutationRunner, PrivateClipboard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav aria-label="Breadcrumb" class="mb-4 text-sm">
      <a routerLink="/orgs">Organizations</a> /
      <a [routerLink]="['/orgs', organizationId()]">Organization</a>
    </nav>
    <section class="max-w-3xl" aria-labelledby="servers-title">
      <h1 id="servers-title">Servers</h1>
      <p class="page-intro">Servers run the agent and host your applications.</p>
      @if (runner.problem(); as problem) {
        <div class="feedback" role="alert">
          <p>{{ problem }}</p>
        </div>
      }
      @switch (nodes.state()) {
        @case ('loading') {
          <p role="status" class="text-muted">Loading servers…</p>
        }
        @case ('failed') {
          <div class="feedback" role="alert">
            <p>{{ nodes.problem() }}</p>
          </div>
        }
        @default {
          @if (nodes.items().length) {
            <table class="mb-8 w-full text-left text-sm" aria-label="Servers">
              <thead>
                <tr class="border-b border-line">
                  <th class="py-2 font-semibold">Name</th>
                  <th class="py-2 font-semibold">Status</th>
                  <th class="py-2 font-semibold">Capacity</th>
                  <th class="py-2"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (node of nodes.items(); track node.id) {
                  <tr class="border-b border-line align-top">
                    <td class="py-2 font-semibold">{{ node.name }}</td>
                    <td
                      class="py-2"
                      [class.text-success]="node.status === 'ready'"
                      [class.text-danger]="node.status === 'down'"
                    >
                      {{ node.status }}
                    </td>
                    <td class="py-2 text-muted">{{ capacity(node) }}</td>
                    <td class="py-2 text-right">
                      <button
                        class="button button-secondary"
                        type="button"
                        [attr.aria-label]="'Remove ' + node.name"
                        (click)="removing.set(node)"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="mb-8 border-y border-line py-6 text-muted">No servers yet. Add one below.</p>
          }
        }
      }

      @if (removing(); as node) {
        <section aria-labelledby="remove-title" class="mb-8 border-y border-danger py-6">
          <h2 id="remove-title">Remove {{ node.name }}</h2>
          <p class="mb-3">
            Its certificates are revoked and its agent is disconnected. This cannot be undone. Type
            <strong>{{ node.name }}</strong> to confirm.
          </p>
          <form [formGroup]="removal" (ngSubmit)="remove(node)" class="grid gap-4">
            <div>
              <label for="remove-name">Server name</label>
              <input
                id="remove-name"
                formControlName="name"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
            <div class="flex gap-3">
              <button
                class="button bg-danger"
                type="submit"
                [disabled]="runner.busy() || removal.controls.name.value !== node.name"
              >
                {{ runner.busy() ? 'Removing…' : 'Remove server' }}
              </button>
              <button class="button button-secondary" type="button" (click)="removing.set(null)">
                Keep it
              </button>
            </div>
          </form>
        </section>
      }

      <section aria-labelledby="add-title" class="border-t border-line pt-6">
        <h2 id="add-title">Add a server</h2>
        @if (issued(); as token) {
          <p class="mb-3">
            This join token is shown once and expires at
            <span class="tabular-nums">{{ token.expiresAt.slice(11, 16) }}</span> UTC. Keep it out
            of shell history and command lines.
          </p>
          <label for="join-token">Join token</label>
          <input
            id="join-token"
            class="mb-2 font-mono text-sm"
            readonly
            [value]="token.token"
            autocomplete="off"
            spellcheck="false"
          />
          <button
            class="button button-secondary mb-2"
            type="button"
            (click)="clipboard.copy(token.token)"
          >
            Copy token
          </button>
          @if (clipboard.message(); as message) {
            <p class="hint" role="status">{{ message }}</p>
          }
          <p class="mt-4">
            On a fresh Ubuntu 24.04 server, run this command, then paste the token when prompted.
            Docker and Caddy will be installed; ports 80 and 443 must be free.
          </p>
          <pre
            class="mt-2 overflow-x-auto rounded-md bg-panel p-3 text-sm"
            aria-label="Install command"
            >{{ command() }}</pre>
          <p class="hint">
            The command checks the installer and agent checksums. The agent checks the CA
            fingerprint before enrolling and deletes the token file after saving its credentials.
            Refresh this page to check for ready.
          </p>
          <button class="button button-secondary mt-4" type="button" (click)="issued.set(null)">
            Done
          </button>
        } @else {
          <p class="hint mb-3">
            Adding a server needs your password: the token lets a machine join this organization.
          </p>
          <form [formGroup]="join" (ngSubmit)="issue()" class="grid gap-4">
            <div>
              <label for="join-password">Your password</label>
              <input
                id="join-password"
                type="password"
                formControlName="password"
                autocomplete="current-password"
              />
            </div>
            <div>
              <label for="join-totp">Authentication code (if enabled)</label>
              <input
                id="join-totp"
                formControlName="totp"
                inputmode="numeric"
                autocomplete="one-time-code"
              />
            </div>
            <div>
              <button class="button" type="submit" [disabled]="runner.busy() || join.invalid">
                {{ runner.busy() ? 'Creating…' : 'Create join token' }}
              </button>
            </div>
          </form>
        }
      </section>
    </section>
  `,
})
export class ServersPage {
  private readonly api = inject(FleetApi);
  private readonly installer = inject(InstallCommand);
  protected readonly command = signal('');
  protected readonly runner = inject(MutationRunner);
  protected readonly clipboard = inject(PrivateClipboard);
  readonly organizationId = input.required<string>();
  protected readonly nodes = new Collection<FleetNode>(() => this.api.nodes(this.organizationId()));
  protected readonly issued = signal<JoinToken | null>(null);
  protected readonly removing = signal<FleetNode | null>(null);
  protected readonly join = new FormGroup({
    password: new FormControl('', { nonNullable: true, validators: [required] }),
    totp: new FormControl('', { nonNullable: true }),
  });
  protected readonly removal = new FormGroup({
    name: new FormControl('', { nonNullable: true }),
  });

  constructor() {
    effect(() => {
      this.organizationId();
      void this.nodes.refresh();
    });
  }

  protected capacity(node: FleetNode): string {
    const cpu = node.facts['cpu_count'];
    const memory = Number(node.facts['memory_bytes']);
    const parts = [
      typeof cpu === 'number' && cpu > 0 ? `${String(cpu)} CPU` : '',
      memory > 0 ? `${String(Math.round(memory / 2 ** 30))} GiB` : '',
    ].filter(Boolean);
    return parts.join(', ') || 'unknown';
  }

  protected async issue(): Promise<void> {
    const { password, totp } = this.join.getRawValue();
    const code = totp.trim();
    const outcome = await this.runner.run({ joinToken: this.organizationId() }, async () => {
      const command = await this.installer.load();
      const token = await this.api.issueJoinToken(this.organizationId(), {
        password,
        ...(code ? { totp: code } : {}),
      });
      return { token, command: command(token) };
    });
    this.join.reset();
    if (outcome.ok) {
      this.command.set(outcome.value.command);
      this.issued.set(outcome.value.token);
    }
  }

  protected async remove(node: FleetNode): Promise<void> {
    const name = this.removal.controls.name.value;
    const outcome = await this.runner.run({ remove: node.id }, async () => {
      const confirmation = await this.api.confirmRemoval(this.organizationId(), node, name);
      await this.api.removeNode(this.organizationId(), node.id, confirmation);
    });
    if (!outcome.ok) return;
    this.removal.reset();
    this.removing.set(null);
    await this.nodes.refresh();
  }
}
