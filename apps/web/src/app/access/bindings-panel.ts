import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidatorFn,
  Validators,
} from '@angular/forms';

import { T } from '../ui/i18n';
import { required } from '../workspace/validators';

import {
  AccessApi,
  type Binding,
  type BindingScope,
  type Proof,
  type ResourceRole,
} from './access-api';
import { PagedList } from './paged-list';
import { ReauthForm, reauthControls } from './reauth-form';

const email: ValidatorFn = (control) => Validators.email(control);

/**
 * Roles on a project or an environment. An environment role replaces the project role there, which
 * can narrow access as well as widen it (SPEC 7).
 */
@Component({
  selector: 'sk-bindings-panel',
  imports: [ReactiveFormsModule, ReauthForm, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!bindings.denied()) {
      <section aria-labelledby="bindings-title" class="mt-8 border-t border-line pt-6">
        <h2 id="bindings-title">{{ 'Access' | t }}</h2>
        @if (scope().environmentId) {
          <p class="page-intro">
            {{ "A role set here replaces the person's project role here." | t }}
          </p>
        }
        @if (notice(); as text) {
          <p role="status" class="feedback">{{ text | t }}</p>
        }
        @if (bindings.problem(); as problem) {
          <div class="feedback" role="alert">
            <p>{{ problem | t }}</p>
          </div>
        }
        @switch (bindings.state()) {
          @case ('loading') {
            <p role="status" class="text-muted">{{ 'Loading access…' | t }}</p>
          }
          @case ('ready') {
            @if (bindings.items().length) {
              <ul
                class="mb-8 divide-y divide-line border-y border-line"
                [attr.aria-label]="'Access' | t"
              >
                @for (binding of bindings.items(); track binding.id) {
                  <li class="py-3">
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <span>
                        <span class="break-all">{{ binding.email }}</span>
                        <span class="ml-2 text-sm text-muted"
                          >{{ binding.role | t }}, {{ 'from ' + binding.source | t }}</span
                        >
                      </span>
                      @if (binding.directRole) {
                        <button
                          class="button button-secondary"
                          type="button"
                          [attr.aria-label]="'Remove role of {email}' | t: { email: binding.email }"
                          (click)="select(binding)"
                        >
                          {{ 'Remove role' | t }}
                        </button>
                      }
                    </div>
                    @if (selected()?.id === binding.id) {
                      <div class="mt-4">
                        <p class="hint">
                          {{
                            binding.inheritedRole
                              ? ('They keep the role {role} they inherit.'
                                | t: { role: (binding.inheritedRole | t) })
                              : ('They lose access here.' | t)
                          }}
                        </p>
                        <sk-reauth-form
                          prefix="binding-remove"
                          [label]="'Remove role' | t"
                          [form]="removeForm"
                          [send]="remove"
                          (done)="finished('Role removed.')"
                        >
                          <button
                            secondary
                            class="button button-secondary"
                            type="button"
                            (click)="selected.set(null)"
                          >
                            {{ 'Cancel' | t }}
                          </button>
                        </sk-reauth-form>
                      </div>
                    }
                  </li>
                }
              </ul>
            } @else {
              <p class="mb-8 border-y border-line py-6 text-muted">
                {{ 'Only organization owners and administrators have access for now.' | t }}
              </p>
            }
            @if (bindings.hasMore()) {
              <div class="mb-8">
                <button
                  class="button button-secondary"
                  type="button"
                  [disabled]="bindings.loadingMore()"
                  (click)="bindings.more()"
                >
                  {{ (bindings.loadingMore() ? 'Loading…' : 'Show more people') | t }}
                </button>
              </div>
            }
          }
        }
        <h3>{{ 'Give someone a role' | t }}</h3>
        <p class="hint">{{ 'They must already be a member of the organization.' | t }}</p>
        <sk-reauth-form
          prefix="binding-add"
          [label]="'Give role' | t"
          [form]="assignForm"
          [send]="assign"
          (done)="assigned()"
        >
          <div>
            <label for="binding-add-email">{{ 'Email' | t }}</label>
            <input
              id="binding-add-email"
              type="email"
              [formControl]="assignForm.controls.email"
              maxlength="254"
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <div>
            <label for="binding-add-role">{{ 'Role' | t }}</label>
            <select id="binding-add-role" [formControl]="assignForm.controls.role">
              @for (role of roles; track role) {
                <option [value]="role">{{ role | t }}</option>
              }
            </select>
          </div>
        </sk-reauth-form>
      </section>
    }
  `,
})
export class BindingsPanel {
  private readonly api = inject(AccessApi);
  readonly scope = input.required<BindingScope>();
  protected readonly roles: readonly ResourceRole[] = ['viewer', 'developer', 'admin'];
  protected readonly bindings = new PagedList<Binding>((cursor) =>
    this.api.bindings(this.scope(), cursor),
  );
  protected readonly selected = signal<Binding | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly assignForm = new FormGroup({
    email: new FormControl('', { nonNullable: true, validators: [required, email] }),
    role: new FormControl<ResourceRole>('viewer', { nonNullable: true }),
    ...reauthControls(),
  });
  protected readonly removeForm = new FormGroup(reauthControls());

  protected readonly assign = (proof: Proof, key: string): Promise<void> => {
    const { email, role } = this.assignForm.getRawValue();
    return this.api.assignBinding(this.scope(), { email, role, ...proof }, key);
  };
  protected readonly remove = (proof: Proof, key: string): Promise<void> => {
    const target = this.selected();
    if (!target) throw new Error('No role is selected.');
    return this.api.removeBinding(this.scope(), target.id, proof, key);
  };

  constructor() {
    effect(() => {
      this.scope();
      this.selected.set(null);
      this.notice.set(null);
      void this.bindings.refresh();
    });
  }

  protected select(binding: Binding): void {
    this.notice.set(null);
    this.removeForm.reset();
    this.selected.set(binding);
  }
  protected finished(notice: string): void {
    this.selected.set(null);
    this.notice.set(notice);
    void this.bindings.refresh();
  }
  protected assigned(): void {
    this.assignForm.reset();
    this.finished('Role given.');
  }
}
