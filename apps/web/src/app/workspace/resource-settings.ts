import { Directive, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type FormGroup } from '@angular/forms';

import { MutationRunner } from '../identity/mutation-runner';

import { recoverOnEdit } from './form-recovery';

/** Shared behavior of a settings form: it follows its resource and reports what was saved. */
@Directive()
export abstract class ResourceSettings<Resource extends { id: string }> {
  protected readonly runner = inject(MutationRunner);
  protected readonly saved = signal(false);
  readonly current = input.required<Resource>();
  readonly updated = output<Resource>();
  private shownId: string | null = null;

  protected abstract readonly form: FormGroup;

  /** Call from the subclass constructor, once its form exists. */
  protected connect(): void {
    const form = this.form;
    recoverOnEdit(form, this.runner);
    form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.saved.set(false);
    });
    effect(() => {
      const resource = this.current();
      untracked(() => {
        if (resource.id !== this.shownId) {
          // An answer for the resource shown before must not land on this one.
          this.runner.reset();
          this.saved.set(false);
          this.shownId = resource.id;
        }
        form.reset(this.values(resource), { emitEvent: false });
      });
    });
  }

  protected abstract values(resource: Resource): object;

  protected async persist(body: unknown, send: (key: string) => Promise<Resource>): Promise<void> {
    this.saved.set(false);
    const outcome = await this.runner.run(body, send);
    if (!outcome.ok) return;
    this.saved.set(true);
    this.updated.emit(outcome.value);
  }
}
