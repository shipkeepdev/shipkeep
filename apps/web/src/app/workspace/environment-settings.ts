import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';

import { MutationRunner } from '../identity/mutation-runner';
import { T } from '../ui/i18n';

import { ResourceSettings } from './resource-settings';
import { required, slug } from './validators';
import { type Environment, WorkspaceApi } from './workspace-api';

const settingsForm = () =>
  new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [required, slug] }),
    kind: new FormControl<Environment['kind']>('standard', { nonNullable: true }),
    failoverPolicy: new FormControl<Environment['failoverPolicy']>('none', { nonNullable: true }),
    protected: new FormControl(true, { nonNullable: true }),
  });

/** An environment's name, kind, failover policy and protection (`environment.update`). */
@Component({
  selector: 'sk-environment-settings',
  imports: [ReactiveFormsModule, T],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="environment-settings-title" class="mt-8 border-t border-line pt-6">
      <h2 id="environment-settings-title">{{ 'Settings' | t }}</h2>
      @if (runner.problem(); as problem) {
        <div class="feedback" role="alert">
          <p>{{ problem | t }}</p>
        </div>
      }
      @if (saved()) {
        <p role="status" class="feedback">{{ 'Settings saved.' | t }}</p>
      }
      <form [formGroup]="form" (ngSubmit)="save()" class="grid gap-4">
        <div>
          <label for="environment-settings-name">{{ 'Name' | t }}</label>
          <input
            id="environment-settings-name"
            formControlName="name"
            maxlength="40"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div>
          <label for="environment-settings-kind">{{ 'Kind' | t }}</label>
          <select id="environment-settings-kind" formControlName="kind">
            <option value="standard">{{ 'Standard' | t }}</option>
            <option value="preview">{{ 'Preview' | t }}</option>
          </select>
        </div>
        <div>
          <label for="environment-settings-failover">{{ 'When a server is lost' | t }}</label>
          <select id="environment-settings-failover" formControlName="failoverPolicy">
            <option value="none">{{ 'Do nothing automatically' | t }}</option>
            <option value="restore-from-backup">{{ 'Restore from backup' | t }}</option>
          </select>
        </div>
        <div class="flex items-center gap-2">
          <input
            id="environment-settings-protected"
            type="checkbox"
            formControlName="protected"
            aria-describedby="environment-settings-protected-hint"
          />
          <label for="environment-settings-protected" class="mb-0">{{ 'Protected' | t }}</label>
        </div>
        <p id="environment-settings-protected-hint" class="hint">
          {{
            'Without protection, developers can deploy here, set secrets and open container sessions.'
              | t
          }}
        </p>
        <div>
          <button
            class="button"
            type="submit"
            [disabled]="runner.busy() || !!runner.cooldown() || form.invalid || form.pristine"
          >
            {{ (runner.busy() ? 'Saving…' : 'Save settings') | t }}
          </button>
        </div>
      </form>
    </section>
  `,
})
export class EnvironmentSettings extends ResourceSettings<Environment> {
  private readonly api = inject(WorkspaceApi);
  protected readonly form = settingsForm();

  constructor() {
    super();
    this.connect();
  }

  protected values(environment: Environment): object {
    const { name, kind, failoverPolicy } = environment;
    return { name, kind, failoverPolicy, protected: environment.protected };
  }
  protected save(): Promise<void> {
    const body = this.form.getRawValue();
    const { id, organizationId, projectId } = this.current();
    return this.persist(body, (key) =>
      this.api.updateEnvironment(organizationId, projectId, id, body, key),
    );
  }
}
