import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, Injectable, InjectionToken, signal } from '@angular/core';

export const PRIVATE_CLIPBOARD = new InjectionToken<(value: string) => Promise<void>>(
  'PrivateClipboard',
  {
    providedIn: 'root',
    factory: () => {
      const document = inject(DOCUMENT);
      return async (value) => {
        const clipboard = document.defaultView?.navigator.clipboard;
        if (!clipboard) throw new Error('Clipboard unavailable.');
        await clipboard.writeText(value);
      };
    },
  },
);

/** Component-scoped feedback only. A copy is always initiated by an explicit user gesture. */
@Injectable()
export class PrivateClipboard {
  private readonly write = inject(PRIVATE_CLIPBOARD);
  private readonly destroyRef = inject(DestroyRef);
  private readonly feedback = signal<string | null>(null);
  readonly message = this.feedback.asReadonly();
  #revision = 0;
  constructor() {
    this.destroyRef.onDestroy(() => {
      this.reset();
    });
  }
  reset(): void {
    ++this.#revision;
    this.feedback.set(null);
  }
  async copy(value: string): Promise<void> {
    if (!value || this.destroyRef.destroyed) return;
    const revision = ++this.#revision;
    let message: string;
    try {
      await this.write(value);
      message = 'Copied. Save it in a secure place.';
    } catch {
      message = 'Could not copy. Select the text and copy it manually.';
    }
    if (revision === this.#revision) this.feedback.set(message);
  }
}
