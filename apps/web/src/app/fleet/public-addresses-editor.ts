import {
  type AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  effect,
  type ElementRef,
  inject,
  input,
  type OnDestroy,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';

import { IdentityRequestError } from '../identity/identity-api';
import { MutationRunner } from '../identity/mutation-runner';
import { T } from '../ui/i18n';
import { recoverOnEdit } from '../workspace/form-recovery';

import { FleetApi, type FleetNode } from './fleet-api';
import {
  type AddressMessage,
  addressProblem,
  MAX_PUBLIC_ADDRESSES,
  readPublicAddresses,
} from './public-addresses';

/**
 * Edits the public addresses an administrator declares for a server (PLAN M3.6b1). The page is
 * only reachable with `node.manage`; the API checks it again and validates every value.
 */
@Component({
  selector: 'sk-public-addresses-editor',
  imports: [ReactiveFormsModule, T],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'cancel()' },
  template: `
    <section aria-labelledby="addresses-title" class="card flex max-w-[640px] flex-col gap-3 p-5">
      <h2 id="addresses-title" class="text-[15px] font-medium">
        {{ 'Public addresses of {name}' | t: { name: node().name } }}
      </h2>
      <p id="addresses-help" class="text-[13px] leading-[1.55] text-fg3">
        {{
          'The IPv4 and IPv6 addresses visitors reach this server on, one per line, at most {n}. The application page compares each domain with them.'
            | t: { n: max }
        }}
      </p>
      <form (submit)="save($event)" class="flex flex-col gap-3" novalidate>
        <label for="public-addresses" class="text-[12px] text-fg3">{{
          'Public addresses' | t
        }}</label>
        <textarea
          #field
          id="public-addresses"
          class="input min-h-[92px] resize-y font-mono text-[12.5px] leading-[1.6]"
          rows="3"
          [formControl]="text"
          [attr.aria-invalid]="message() ? 'true' : null"
          aria-describedby="addresses-help addresses-error"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
        ></textarea>
        <p id="addresses-error" class="field-error -mt-1" role="alert">
          @if (message(); as m) {
            {{ m.text | t: m.params }}
          }
        </p>
        @if (!message() && runner.problem(); as problem) {
          <div class="alert" role="alert">{{ problem | t }}</div>
        }
        <div class="flex flex-wrap gap-2.5">
          <button
            class="btn btn-primary"
            type="submit"
            [disabled]="runner.busy() || !!runner.cooldown()"
          >
            {{ (runner.busy() ? 'Saving…' : 'Save addresses') | t }}
          </button>
          <button class="btn btn-sm" type="button" (click)="cancel()">{{ 'Cancel' | t }}</button>
        </div>
      </form>
    </section>
  `,
})
export class PublicAddressesEditor implements AfterViewInit, OnDestroy {
  private readonly api = inject(FleetApi);
  private readonly document = inject(DOCUMENT);
  private readonly field = viewChild.required<ElementRef<HTMLTextAreaElement>>('field');
  /** Where focus goes back to: the button that opened this. */
  private readonly opener = this.document.activeElement;
  protected readonly runner = inject(MutationRunner);
  protected readonly max = MAX_PUBLIC_ADDRESSES;
  readonly organizationId = input.required<string>();
  readonly node = input.required<FleetNode>();
  readonly saved = output<FleetNode>();
  readonly cancelled = output();
  /** True while a save is in flight, so the page holds other server actions until it settles. */
  readonly saving = output<boolean>();
  protected readonly text = new FormControl('', { nonNullable: true });
  protected readonly message = signal<AddressMessage | null>(null);

  constructor() {
    recoverOnEdit(this.text, this.runner);
    this.text.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.message.set(null);
    });
    effect(() => {
      this.saving.emit(this.runner.busy());
    });
    // Another server selected while this is open starts over from its saved addresses.
    effect(() => {
      const addresses = this.node().publicAddresses.join('\n');
      untracked(() => {
        this.text.setValue(addresses, { emitEvent: false });
        this.message.set(null);
        this.runner.reset();
      });
    });
  }
  ngAfterViewInit(): void {
    this.field().nativeElement.focus();
  }
  ngOnDestroy(): void {
    if (this.opener instanceof HTMLElement && this.opener.isConnected) this.opener.focus();
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const input = readPublicAddresses(this.text.value);
    if (!input.ok) {
      this.message.set(input.message);
      return;
    }
    const outcome = await this.runner.run(
      { node: this.node().id, addresses: input.addresses },
      async (_key, isCurrent) => {
        try {
          return await this.api.setPublicAddresses(
            this.organizationId(),
            this.node().id,
            input.addresses,
          );
        } catch (error: unknown) {
          // Another server selected meanwhile: this refusal is not about the field shown now.
          if (error instanceof IdentityRequestError && isCurrent())
            this.message.set(addressProblem(error.problem) ?? null);
          throw error;
        }
      },
    );
    if (outcome.ok) this.saved.emit(outcome.value);
  }

  protected cancel(): void {
    if (!this.runner.busy()) this.cancelled.emit();
  }
}
