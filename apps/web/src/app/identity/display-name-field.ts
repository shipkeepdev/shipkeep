import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';

import { T } from '../ui/i18n';

import { displayNameTooLong } from './account-name';
import { IdentityRequestError } from './identity-api';
import { SessionStore } from './session-store';

/**
 * Profile → Account → Name (issue #251): the name the account shows instead of its address.
 * Saving answers the session with the new name, so the sidebar and the page follow at once.
 */
@Component({
  selector: 'sk-display-name-field',
  imports: [T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="flex flex-wrap items-center gap-2" (submit)="save($event)">
      <label class="sr-only" for="display-name">{{ 'Name' | t }}</label>
      <input
        id="display-name"
        class="input min-w-0 flex-1"
        maxlength="256"
        [disabled]="busy()"
        autocomplete="name"
        [placeholder]="'Your name' | t"
        [value]="draft()"
        (input)="edit($event)"
      />
      <button class="btn btn-sm" type="submit" [disabled]="busy() || !changed() || tooLong()">
        {{ (busy() ? 'Saving…' : 'Save') | t }}
      </button>
      @if (tooLong()) {
        <span class="basis-full text-[12px] text-rose" role="status">{{
          'A name has at most 64 characters, and no control character.' | t
        }}</span>
      } @else if (message(); as text) {
        <span class="basis-full text-[12px] text-mute" role="status">{{ text | t }}</span>
      }
    </form>
  `,
})
export class DisplayNameField {
  private readonly session = inject(SessionStore);
  protected readonly draft = signal('');
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  private saved = '';

  constructor() {
    // The field shows the name the session holds, until the account edits it.
    effect(() => {
      const name = this.session.profile()?.displayName ?? '';
      this.saved = name;
      this.draft.set(name);
    });
  }

  protected changed(): boolean {
    return this.draft().trim() !== this.saved;
  }

  protected tooLong(): boolean {
    return displayNameTooLong(this.draft());
  }

  protected edit(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
    this.message.set(null);
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || !this.changed() || this.tooLong()) return;
    this.busy.set(true);
    this.message.set(null);
    try {
      const name = this.draft().trim();
      await this.session.setDisplayName(name === '' ? null : name);
      this.message.set('Saved.');
    } catch (error) {
      this.message.set(
        error instanceof IdentityRequestError && error.status === 400
          ? 'A name has at most 64 characters, and no control character.'
          : 'The name could not be saved. Try again.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}
