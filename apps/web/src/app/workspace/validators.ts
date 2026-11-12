import { type ValidatorFn, Validators } from '@angular/forms';

/** Bound wrappers: passing `Validators.required` directly would lose its `this`. */
export const required: ValidatorFn = (control) => Validators.required(control);
/** Slugs and names in URLs: lowercase letter first, then letters, digits and hyphens. */
export const slug: ValidatorFn = Validators.pattern(/^[a-z][a-z0-9-]*$/);
/** Display names as the API accepts them: 1-80 code points, no control or format characters. */
export const displayName: ValidatorFn = (control) => {
  const value: unknown = control.value;
  return typeof value === 'string' &&
    value.trim() &&
    Array.from(value.trim()).length <= 80 &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
    ? null
    : { displayName: true };
};
