import { type ValidatorFn, Validators } from '@angular/forms';

/** Bound wrappers: passing `Validators.required` directly would lose its `this`. */
export const required: ValidatorFn = (control) => Validators.required(control);
/** Slugs and names in URLs: lowercase letter first, then letters, digits and hyphens. */
export const slug: ValidatorFn = Validators.pattern(/^[a-z][a-z0-9-]*$/);
