import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
  signal,
  type WritableSignal,
} from '@angular/core';

import { MutationRunner } from '../identity/mutation-runner';
import { I18n, T } from '../ui/i18n';
import { ConfirmByName } from '../workspace/confirm-by-name';

import { type Application, DeliveryApi, type EnvironmentRef } from './delivery-api';

/**
 * The two actions of an application's danger zone that exist: stopping it and deleting it
 * (issue #256). Stopping asks once more in place; deleting asks for the application's name, which
 * the server checks before it issues the confirmation.
 */
@Component({
  selector: 'sk-application-danger',
  imports: [ConfirmByName, T],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-3.5' },
  template: `
    @if (runner.problem(); as problem) {
      <div class="alert" role="alert">{{ problem | t }}</div>
    }
    <div class="overflow-hidden rounded-2xl border border-[rgb(255_92_92/35%)] bg-black">
      <div class="flex items-center justify-between gap-4 px-5 py-4 max-sm:flex-wrap">
        <div>
          <div class="text-[13.5px]">
            {{ (startable() ? 'Start the application' : 'Stop the application') | t }}
          </div>
          <div class="mt-[3px] text-[12px] text-mute2">
            {{
              (running()
                ? 'Its routes and replicas are removed, and their room on the servers is freed. Releases and history are kept; deploying starts it again.'
                : startable()
                  ? 'It is stopped. Starting it deploys again the version it ran before the stop.'
                  : 'It has no running replica.'
              ) | t
            }}
          </div>
        </div>
        @if (startable() && !running()) {
          <button
            class="btn"
            type="button"
            [disabled]="busy() || deploying()"
            (click)="start.emit()"
          >
            {{ 'Start' | t }}
          </button>
        } @else if (stopping()) {
          <div class="flex flex-wrap gap-2.5">
            <button class="btn btn-danger" type="button" [disabled]="busy()" (click)="stop()">
              {{ (runner.busy() ? 'Stopping…' : 'Stop it now') | t }}
            </button>
            <button
              class="btn"
              type="button"
              [disabled]="runner.busy()"
              (click)="ask(stopping, false)"
            >
              {{ 'Keep it running' | t }}
            </button>
          </div>
        } @else {
          <button
            class="btn btn-danger"
            type="button"
            [disabled]="busy() || !running() || deploying()"
            (click)="ask(stopping, true)"
          >
            {{ 'Stop' | t }}
          </button>
        }
      </div>
      <div
        class="flex items-center justify-between gap-4 border-t border-line2 px-5 py-4 max-sm:flex-wrap"
      >
        <div>
          <div class="text-[13.5px]">{{ 'Delete the application' | t }}</div>
          <div class="mt-[3px] text-[12px] text-mute2">
            {{
              (running() || deploying()
                ? 'Stop it first: an application is deleted only when nothing of it runs.'
                : 'Its releases, deployments and domains are deleted with it. The audit log is kept.'
              ) | t
            }}
          </div>
        </div>
        <button
          class="btn btn-danger"
          type="button"
          [disabled]="busy() || running() || deploying() || deleting()"
          (click)="ask(deleting, true)"
        >
          {{ 'Delete' | t }}
        </button>
      </div>
    </div>
    @if (deleting()) {
      <sk-confirm-by-name
        [heading]="i18n.t('Delete {name}', { name: application().name })"
        [resourceName]="application().name"
        [fieldLabel]="i18n.t('Application name')"
        [actionLabel]="i18n.t('Delete the application')"
        [busyLabel]="i18n.t('Deleting…')"
        [keepLabel]="i18n.t('Keep the application')"
        [typeLabel]="i18n.t('This cannot be undone. Type its name to confirm:')"
        [busy]="runner.busy()"
        [blocked]="!!runner.cooldown()"
        (confirmed)="remove($event)"
        (cancelled)="ask(deleting, false)"
      />
    }
  `,
})
export class ApplicationDanger {
  private readonly api = inject(DeliveryApi);
  protected readonly runner = inject(MutationRunner);
  protected readonly i18n = inject(I18n);
  readonly environment = input.required<EnvironmentRef>();
  readonly application = input.required<Pick<Application, 'id' | 'name'>>();
  /** True while a replica of the application is placed on a server. */
  readonly running = input.required<boolean>();
  /** True when the application was stopped and the version it ran can be started again. */
  readonly startable = input(false);
  /** Start was clicked: the page deploys the stopped version again. */
  readonly start = output();
  /** True while a deployment of the application, a stop included, has not finished. */
  readonly deploying = input.required<boolean>();
  /** A stop was queued: the page reloads the deployments and follows it. */
  readonly stopped = output();
  /** The application no longer exists. */
  readonly deleted = output();
  protected readonly stopping = signal(false);
  protected readonly deleting = signal(false);

  protected busy(): boolean {
    return this.runner.busy() || !!this.runner.cooldown();
  }

  /**
   * Opens or closes one of the two questions. Each time starts a new attempt: a refusal left by
   * the previous one (a 409 while a deployment ran, for example) would otherwise make every later
   * click do nothing. A wait the server asked for is kept.
   */
  protected ask(question: WritableSignal<boolean>, open: boolean): void {
    this.runner.reset();
    question.set(open);
  }

  protected async stop(): Promise<void> {
    const outcome = await this.runner.run({ stop: this.application().id }, () =>
      this.api.stop(this.environment(), this.application().id),
    );
    this.stopping.set(false);
    if (outcome.ok) this.stopped.emit();
  }

  protected async remove(name: string): Promise<void> {
    const application = this.application();
    const outcome = await this.runner.run({ delete: application.id, name }, async () => {
      const confirmation = await this.api.confirmDeletion(
        this.environment().organizationId,
        application,
        name,
      );
      await this.api.deleteApplication(this.environment(), application.id, confirmation);
    });
    if (outcome.ok) this.deleted.emit();
    else this.deleting.set(false);
  }
}
