import { computed, inject, Injectable, signal } from '@angular/core';
import {
  type ConfigIssue,
  parseShipkeepConfig,
  type ShipkeepConfig,
} from '@shipkeep/config-schema';
import { stringify } from 'yaml';

import { IdentityRequestError } from '../identity/identity-api';
import { MutationRunner } from '../identity/mutation-runner';

import { configDiff } from './config-diff';
import { type Application, DeliveryApi, type EnvironmentRef } from './delivery-api';

/** Component-scoped draft; an optimistic hash protects every save from concurrent edits. */
@Injectable()
export class ConfigurationEditorStore {
  private readonly api = inject(DeliveryApi);
  readonly runner = inject(MutationRunner);
  private environment: EnvironmentRef | undefined;
  readonly current = signal<Application | null>(null);
  readonly draft = signal('');
  readonly issues = signal<readonly ConfigIssue[]>([]);
  readonly preview = signal<ShipkeepConfig | null>(null);
  readonly conflict = signal(false);
  readonly notice = signal<string | null>(null);
  readonly diff = computed(() => {
    const current = this.current();
    const preview = this.preview();
    if (!current || !preview) return [];
    return configDiff(current.config, preview);
  });

  open(environment: EnvironmentRef, application: Application): void {
    this.runner.reset();
    this.environment = environment;
    this.current.set(application);
    this.draft.set(stringify(application.config));
    this.issues.set([]);
    this.preview.set(null);
    this.conflict.set(false);
    this.notice.set(null);
  }

  edit(value: string): void {
    if (this.runner.busy()) return;
    this.draft.set(value);
    this.preview.set(null);
    this.issues.set([]);
    this.notice.set(null);
  }

  review(): void {
    if (this.runner.busy() || this.conflict()) return;
    this.runner.reset();
    this.notice.set(null);
    const parsed = parseShipkeepConfig(this.draft());
    if (!parsed.ok) {
      this.issues.set(parsed.issues.slice(0, 20));
      return;
    }
    const config = parsed.config;
    const issues: ConfigIssue[] = [];
    if (config.name !== this.current()?.name)
      issues.push({ path: '/name', message: 'The application name cannot be changed.' });
    if (config.build?.type !== 'image')
      issues.push({ path: '/build/type', message: 'Only image applications are supported.' });
    if (new TextEncoder().encode(JSON.stringify(config)).length > 65536)
      issues.push({ path: '/', message: 'The configuration exceeds 64 KiB.' });
    this.issues.set(issues);
    this.preview.set(issues.length ? null : config);
    if (!issues.length && !this.diff().length) this.notice.set('No configuration changes to save.');
  }

  async save(): Promise<void> {
    const current = this.current();
    const config = this.preview();
    const environment = this.environment;
    if (!current || !config || !environment || this.conflict() || !this.diff().length) return;
    const outcome = await this.runner.run(
      { id: current.id, sha: current.configSha, config },
      async (_, isCurrent) => {
        try {
          return await this.api.updateConfig(environment, current.id, current.configSha, config);
        } catch (error: unknown) {
          if (error instanceof IdentityRequestError && error.status === 409) {
            if (isCurrent()) this.conflict.set(true);
            return undefined;
          }
          throw error;
        }
      },
    );
    if (!outcome.ok || !outcome.value) return;
    this.current.set(outcome.value);
    this.draft.set(stringify(outcome.value.config));
    this.preview.set(null);
    this.notice.set('Configuration saved. Deploy when you are ready to apply it.');
  }

  async reload(): Promise<void> {
    const current = this.current();
    const environment = this.environment;
    if (!current || !environment || this.runner.busy()) return;
    this.runner.reset();
    const outcome = await this.runner.run({ reload: current.id }, () =>
      this.api.application(environment, current.id),
    );
    if (!outcome.ok) return;
    this.current.set(outcome.value);
    this.preview.set(null);
    this.conflict.set(false);
    this.notice.set(
      'Latest version loaded. Your draft is unchanged; review it against the latest version.',
    );
  }
}
