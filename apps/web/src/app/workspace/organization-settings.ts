import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';

import { MutationRunner } from '../identity/mutation-runner';

import { ResourceSettings } from './resource-settings';
import { displayName, required, slug } from './validators';
import { type Organization, WorkspaceApi } from './workspace-api';

const settingsForm = () =>
  new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [displayName] }),
    slug: new FormControl('', { nonNullable: true, validators: [required, slug] }),
  });

/** An organization's name and slug (`organization.update`). */
@Component({
  selector: 'sk-organization-settings',
  imports: [ReactiveFormsModule],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="organization-settings-title" class="mt-8 border-t border-line pt-6">
      <h2 id="organization-settings-title">Settings</h2>
      @if (runner.problem(); as problem) {
        <div class="feedback" role="alert">
          <p>{{ problem }}</p>
        </div>
      }
      @if (saved()) {
        <p role="status" class="feedback">Settings saved.</p>
      }
      <form [formGroup]="form" (ngSubmit)="save()" class="grid gap-4">
        <div>
          <label for="organization-settings-name">Name</label>
          <input id="organization-settings-name" formControlName="name" maxlength="80" />
        </div>
        <div>
          <label for="organization-settings-slug">Slug</label>
          <input
            id="organization-settings-slug"
            formControlName="slug"
            maxlength="40"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div>
          <button
            class="button"
            type="submit"
            [disabled]="runner.busy() || !!runner.cooldown() || form.invalid || form.pristine"
          >
            {{ runner.busy() ? 'Saving…' : 'Save settings' }}
          </button>
        </div>
      </form>
    </section>
  `,
})
export class OrganizationSettings extends ResourceSettings<Organization> {
  private readonly api = inject(WorkspaceApi);
  protected readonly form = settingsForm();

  constructor() {
    super();
    this.connect();
  }

  protected values({ name, slug }: Organization): object {
    return { name, slug };
  }
  protected save(): Promise<void> {
    const { name, slug } = this.form.getRawValue();
    const body = { name: name.trim(), slug };
    const { id } = this.current();
    return this.persist(body, (key) => this.api.updateOrganization(id, body, key));
  }
}
