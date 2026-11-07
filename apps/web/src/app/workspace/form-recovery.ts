import { type AbstractControl } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import type { MutationRunner } from '../identity/mutation-runner';

/**
 * A refused request (a slug already taken, say) blocks the runner until it restarts. Editing the
 * form is that restart: without it a corrected value would silently never be submitted. Any wait
 * the server asked for still applies. Call from an injection context.
 */
export function recoverOnEdit(form: AbstractControl, runner: MutationRunner): void {
  form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
    if (runner.restartRequired()) runner.reset();
  });
}
