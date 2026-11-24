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

import { BLUE, GREEN, GREY, RED } from '../dashboard/format';
import { IdentityRequestError } from '../identity/identity-api';
import { MutationRunner } from '../identity/mutation-runner';
import { T } from '../ui/i18n';

import { agentUpgradeView, startRefusal, type UpgradeTurn } from './agent-upgrade-view';
import { type AgentUpgradeOverview, FleetApi, type FleetNode } from './fleet-api';

/** How often a running rollout is read again. */
export const POLL_MS = 5000;

const TURNS: Readonly<Record<UpgradeTurn, { readonly label: string; readonly color: string }>> = {
  done: { label: 'upgraded', color: GREEN },
  current: { label: 'upgrading', color: BLUE },
  waiting: { label: 'waiting', color: GREY },
  stopped: { label: 'upgrade stopped', color: RED },
};

/**
 * Agent upgrades on the Servers page (ADR 0028): how many agents run an older release than the
 * control plane, the rollout in progress, or why the last one stopped. The page is only reachable
 * with `node.manage`; the API checks it again.
 */
@Component({
  selector: 'sk-agent-upgrades',
  imports: [T],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let v = view();
    @if (v.kind !== 'hidden') {
      <section
        class="card flex flex-col gap-3 px-5 py-4"
        aria-labelledby="agent-upgrades-title"
        [attr.aria-busy]="runner.busy()"
      >
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
            <h2 id="agent-upgrades-title" class="text-[14px] font-medium">
              {{ 'Agent upgrades' | t }}
            </h2>
            @switch (v.kind) {
              @case ('pending') {
                <p class="text-[12.5px] leading-[1.55] text-fg3">
                  {{
                    (v.pending === 1
                      ? '1 server runs an older agent than the control plane, {version}.'
                      : '{n} servers run an older agent than the control plane, {version}.'
                    ) | t: { n: v.pending, version: v.version }
                  }}
                </p>
              }
              @case ('running') {
                <p class="text-[12.5px] leading-[1.55] text-fg3" role="status">
                  {{
                    'Upgrading agents to {version}: server {n} of {total}, {name}.'
                      | t: { version: v.version, n: v.position, total: v.total, name: v.current }
                  }}
                </p>
              }
              @case ('failed') {
                <p class="text-[12.5px] leading-[1.55] text-fg3">
                  {{
                    (v.pending === 1
                      ? '1 server still runs an older agent than {version}.'
                      : '{n} servers still run an older agent than {version}.'
                    ) | t: { n: v.pending, version: v.version }
                  }}
                </p>
              }
            }
          </div>
          @if (v.kind !== 'running') {
            <button
              type="button"
              class="btn btn-sm btn-primary"
              [disabled]="runner.busy() || !!runner.cooldown()"
              (click)="start(v.version)"
            >
              {{ (runner.busy() ? 'Starting…' : 'Upgrade agents') | t }}
            </button>
          }
        </div>

        @if (v.kind === 'failed') {
          <div class="alert flex-col gap-1" role="alert">
            <span class="font-medium text-fg">{{
              'The upgrade stopped at {name}.' | t: { name: v.server }
            }}</span>
            <span>{{ v.sentence | t: { name: v.server } }}</span>
            @if (v.detail; as detail) {
              <span>{{ 'Reason: {reason}.' | t: { reason: (detail | t) } }}</span>
            }
          </div>
        }

        @if (v.kind === 'running' || v.kind === 'failed') {
          <ol
            class="m-0 flex list-none flex-wrap gap-2 p-0"
            [attr.aria-label]="'Servers, in the order of their turns' | t"
          >
            @for (s of v.servers; track s.id) {
              <li class="pill" [attr.aria-current]="s.turn === 'current' ? 'step' : null">
                <span class="dot" [style.background]="turns[s.turn].color"></span>
                <span class="font-mono text-[11.5px] text-fg2">{{ s.name }}</span
                >&ngsp;<span class="text-[11px] text-dim">{{ turns[s.turn].label | t }}</span>
              </li>
            }
          </ol>
        }

        @if (v.kind === 'pending') {
          <p class="text-[12px] leading-[1.55] text-mute">
            {{
              'One server at a time. Each agent checks the release signature, restarts, and comes back; applications keep running.'
                | t
            }}
          </p>
        }

        @if (refusal() ?? runner.problem(); as problem) {
          <p class="alert" role="alert">{{ problem | t }}</p>
        }
      </section>
    }
  `,
})
export class AgentUpgrades {
  private readonly api = inject(FleetApi);
  protected readonly runner = inject(MutationRunner);
  protected readonly turns = TURNS;
  readonly organizationId = input.required<string>();
  /** The page's servers, for their names. */
  readonly nodes = input<readonly FleetNode[]>([]);
  /** A rollout ended: the servers' versions changed. */
  readonly rolloutEnded = output();

  private readonly overview = signal<AgentUpgradeOverview | null>(null);
  /** Why the last start was refused, when the API said why. */
  protected readonly refusal = signal<string | null>(null);
  private revision = 0;

  protected readonly view = computed(() =>
    agentUpgradeView(
      this.overview(),
      new Map(this.nodes().map((node) => [node.id, node.name] as const)),
    ),
  );
  private readonly running = computed(() => this.view().kind === 'running');

  constructor() {
    effect(() => {
      this.organizationId();
      untracked(() => {
        // Nothing of another organization's rollout stays on screen.
        this.overview.set(null);
        this.refusal.set(null);
        this.runner.reset();
        void this.load();
      });
    });
    // While a rollout runs, read it again; the effect's cleanup stops on end and on destroy.
    effect((onCleanup) => {
      if (!this.running()) return;
      const timer = setInterval(() => void this.load(), POLL_MS);
      onCleanup(() => {
        clearInterval(timer);
      });
    });
  }

  /** Reads the overview; a failed read keeps what is shown, and a stale one is dropped. */
  async load(): Promise<void> {
    const revision = ++this.revision;
    const organizationId = this.organizationId();
    try {
      const overview = await this.api.agentUpgrades(organizationId);
      if (revision !== this.revision) return;
      const wasRunning = this.running();
      this.overview.set(overview);
      if (wasRunning && !this.running()) this.rolloutEnded.emit();
    } catch {
      // The page has its own errors; a missing overview only hides this card.
    }
  }

  protected async start(version: string): Promise<void> {
    const organizationId = this.organizationId();
    this.refusal.set(null);
    const outcome = await this.runner.run({ agentUpgrade: organizationId, version }, async () => {
      try {
        return await this.api.startAgentUpgrade(organizationId, version);
      } catch (error: unknown) {
        if (error instanceof IdentityRequestError)
          this.refusal.set(startRefusal(error.problem?.code));
        throw error;
      }
    });
    if (organizationId !== this.organizationId()) return;
    // A refusal the API explained is settled by reading the state again, not by a restart.
    if (!outcome.ok && this.refusal()) this.runner.reset();
    await this.load();
  }
}
