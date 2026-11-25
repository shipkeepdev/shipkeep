import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';

import { Icon } from '../shell/icon';
import { IdentityRequestError } from '../identity/identity-api';
import { I18n, T } from '../ui/i18n';

import { DeliveryApi, type EnvironmentRef } from './delivery-api';
import { appendLine, appendOutput, END_REASONS, type Screen, serverMessage } from './terminal-view';

type State = 'idle' | 'connecting' | 'open' | 'ended';

/**
 * A command line in the first replica of the application (r0) (SPEC 3.1): each line typed goes to a shell in
 * the container, through the API and the server's agent, never through SSH. Output is text, its
 * terminal escape sequences removed. The session is audited, and ends at its time limit.
 */
@Component({
  selector: 'sk-terminal',
  imports: [Icon, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-3' },
  template: `
    <div class="note note-warn">
      <sk-icon name="shield-lock" class="text-amber" />
      <span>{{
        'Session recorded in the audit log. The terminal goes through the agent: no SSH port is open.'
          | t
      }}</span>
    </div>
    @if (problem(); as p) {
      <div class="alert" role="alert">{{ p | t }}</div>
    }
    <div class="card overflow-hidden">
      <div
        class="flex items-center gap-2.5 border-b border-line px-4 py-2.5 font-mono text-[11.5px] text-mute"
      >
        <span class="text-fg">{{ name() }}</span
        ><span>r0 · sh</span>
        <span class="ml-auto flex items-center gap-2">
          @switch (state()) {
            @case ('open') {
              <span class="flex items-center gap-1.5"
                ><span class="dot bg-green"></span>{{ 'shell connected' | t }}</span
              >
              <button type="button" class="btn btn-sm" (click)="disconnect()">
                {{ 'Disconnect' | t }}
              </button>
            }
            @case ('connecting') {
              <span role="status">{{ 'connecting…' | t }}</span>
            }
            @default {
              <span>{{ 'not connected' | t }}</span>
              <button type="button" class="btn btn-sm btn-primary" (click)="connect()">
                {{ 'Connect' | t }}
              </button>
            }
          }
        </span>
      </div>
      <div
        class="flex max-h-[420px] min-h-[260px] flex-col overflow-auto px-4 py-3.5 font-mono text-[12.5px] leading-[1.8]"
        role="log"
        [attr.aria-label]="'Terminal output' | t"
      >
        @for (l of screen().lines; track $index) {
          <div
            class="whitespace-pre-wrap break-all"
            [class.text-fg2]="l.kind === 'stdout'"
            [class.text-rose]="l.kind === 'stderr'"
            [class.text-fg]="l.kind === 'input'"
            [class.text-mute]="l.kind === 'note'"
          >
            @if (l.kind === 'input') {
              <span class="text-rose">$ </span>
            }
            {{ l.text }}
            @if (l.truncated) {
              <span class="text-dim"> …</span>
            }
          </div>
        }
        @if (state() === 'open') {
          <form
            class="flex gap-2"
            (submit)="$event.preventDefault(); send(command.value); command.value = ''"
          >
            <span class="text-rose">$</span>
            <input
              #command
              class="min-w-0 flex-1 bg-transparent text-fg outline-none"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              [attr.aria-label]="'Command' | t"
            />
          </form>
        }
      </div>
    </div>
  `,
})
export class TerminalPanel {
  private readonly api = inject(DeliveryApi);
  private readonly i18n = inject(I18n);
  readonly environment = input.required<EnvironmentRef>();
  readonly applicationId = input.required<string>();
  readonly name = input.required<string>();
  protected readonly state = signal<State>('idle');
  protected readonly screen = signal<Screen>({ lines: [], open: false });
  protected readonly problem = signal<string | null>(null);
  private socket: WebSocket | null = null;
  /** Set once the panel is gone: a session opened meanwhile is not joined. */
  private destroyed = false;
  private readonly encoder = new TextEncoder();
  private readonly decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.disconnect();
    });
  }

  protected async connect(): Promise<void> {
    if (this.state() === 'connecting' || this.state() === 'open') return;
    this.state.set('connecting');
    this.problem.set(null);
    try {
      const session = await this.api.openExecSession(this.environment(), this.applicationId(), {
        replica: 0,
        argv: ['sh'],
        tty: false,
        minutes: 30,
      });
      // Left while the session was being opened: it is not joined, and the server ends it once
      // nobody joins in time.
      if (this.destroyed) return;
      const url = new URL(session.websocketPath, window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      socket.onopen = () => {
        this.state.set('open');
        this.note('Connected to a shell in the first replica.');
      };
      socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
        this.receive(event.data);
      };
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
        if (this.state() !== 'ended') this.end('The session was closed.');
      };
    } catch (error: unknown) {
      this.state.set('idle');
      // The API's own reason (no permission, replica not running, too many sessions) when it
      // gave one.
      this.problem.set(
        error instanceof IdentityRequestError
          ? error.message
          : 'The session could not be opened. Is the application running?',
      );
    }
  }

  protected send(command: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    this.screen.update((screen) => appendLine(screen, { kind: 'input', text: command }));
    socket.send(this.encoder.encode(`${command}\n`));
  }

  protected disconnect(): void {
    const socket = this.socket;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: 'close', kill: true }));
    socket.close();
    this.socket = null;
  }

  private receive(data: ArrayBuffer | string): void {
    if (typeof data === 'string') {
      const message = serverMessage(data);
      if (message?.exit !== undefined)
        this.end('The command exited with code {code}.', { code: String(message.exit) });
      else if (message?.reason) this.end(END_REASONS[message.reason] ?? 'The session was closed.');
      return;
    }
    const bytes = new Uint8Array(data);
    const kind = bytes[0] === 2 ? 'stderr' : 'stdout';
    const text = this.decoders[kind].decode(bytes.subarray(1), { stream: true });
    this.screen.update((screen) => appendOutput(screen, kind, text));
  }

  /** `reason` is the English text, translated once here, with its values. */
  private end(reason: string, values?: Record<string, string>): void {
    this.state.set('ended');
    this.note(reason, values);
  }

  private note(text: string, values?: Record<string, string>): void {
    const shown = this.i18n.t(text, values);
    this.screen.update((screen) => appendLine(screen, { kind: 'note', text: shown }));
  }
}
