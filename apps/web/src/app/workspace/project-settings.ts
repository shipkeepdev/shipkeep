import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';

import { MutationRunner } from '../identity/mutation-runner';

import { ResourceSettings } from './resource-settings';
import { displayName, required, slug } from './validators';
import { type Project, WorkspaceApi } from './workspace-api';

const settingsForm = () =>
  new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [displayName] }),
    slug: new FormControl('', { nonNullable: true, validators: [required, slug] }),
    gitWriteMode: new FormControl<Project['gitWriteMode']>('pull_request', { nonNullable: true }),
  });

/** A project's name, slug and how the UI writes to `shipkeep.yml` (`project.update`). */
@Component({
  selector: 'sk-project-settings',
  imports: [ReactiveFormsModule],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="project-settings-title" class="mt-8 border-t border-line pt-6">
      <h2 id="project-settings-title">Settings</h2>
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
          <label for="project-settings-name">Name</label>
          <input id="project-settings-name" formControlName="name" maxlength="80" />
        </div>
        <div>
          <label for="project-settings-slug">Slug</label>
          <input
            id="project-settings-slug"
            formControlName="slug"
            maxlength="40"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div>
          <label for="project-settings-git">Changes to shipkeep.yml</label>
          <select id="project-settings-git" formControlName="gitWriteMode">
            <option value="pull_request">Open a pull request</option>
            <option value="commit">Commit directly</option>
          </select>
        </div>
        <div>
          <button
            class="button"
            type="submit"
            [disabled]="runner.busy() || form.invalid || form.pristine"
          >
            {{ runner.busy() ? 'Saving…' : 'Save settings' }}
          </button>
        </div>
      </form>
    </section>
  `,
})
export class ProjectSettings extends ResourceSettings<Project> {
  private readonly api = inject(WorkspaceApi);
  protected readonly form = settingsForm();

  constructor() {
    super();
    this.connect();
  }

  protected values({ name, slug, gitWriteMode }: Project): object {
    return { name, slug, gitWriteMode };
  }
  protected save(): Promise<void> {
    const { name, slug, gitWriteMode } = this.form.getRawValue();
    const body = { name: name.trim(), slug, gitWriteMode };
    const { id, organizationId } = this.current();
    return this.persist(body, (key) => this.api.updateProject(organizationId, id, body, key));
  }
}
