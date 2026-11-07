import {
  type AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  DOCUMENT,
  effect,
  type ElementRef,
  inject,
  input,
  type OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';

/**
 * Asks for a resource's exact name before a destructive action (architecture rule 7, SPEC 3.6).
 * The typed name also goes to the server, which issues the single-use confirmation token only if
 * it matches: this check is a convenience, the server's is the guarantee.
 */
@Component({
  selector: 'sk-confirm-by-name',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'cancel()' },
  template: `
    <section
      role="alertdialog"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-description"
      class="mb-8 border-y border-danger py-6"
    >
      <h2 id="confirm-title">{{ heading() }}</h2>
      <div id="confirm-description" class="mb-3">
        <ng-content />
        Type <strong>{{ resourceName() }}</strong> to confirm.
      </div>
      <form (submit)="confirm($event)" class="grid gap-4">
        <div>
          <label for="confirm-name">{{ fieldLabel() }}</label>
          <input
            #field
            id="confirm-name"
            [value]="typed()"
            (input)="typed.set(read($event))"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
          />
        </div>
        <div class="flex flex-wrap gap-3">
          <button class="button bg-danger" type="submit" [disabled]="busy() || !matches()">
            {{ busy() ? busyLabel() : actionLabel() }}
          </button>
          <button class="button button-secondary" type="button" (click)="cancel()">
            {{ keepLabel() }}
          </button>
        </div>
      </form>
    </section>
  `,
})
export class ConfirmByName implements AfterViewInit, OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  /** Where focus goes back to: the button that opened this. */
  private readonly opener = this.document.activeElement;
  readonly heading = input.required<string>();
  readonly resourceName = input.required<string>();
  readonly fieldLabel = input.required<string>();
  readonly actionLabel = input.required<string>();
  readonly busyLabel = input.required<string>();
  readonly keepLabel = input('Keep it');
  readonly busy = input(false);
  readonly confirmed = output<string>();
  readonly cancelled = output();
  protected readonly typed = signal('');
  /** Exact: no trimming or case folding, so a lookalike or a stray space never confirms. */
  protected readonly matches = computed(() => this.typed() === this.resourceName());

  constructor() {
    // Another resource selected while this is open starts over.
    effect(() => {
      this.resourceName();
      this.typed.set('');
    });
  }

  ngAfterViewInit(): void {
    this.field().nativeElement.focus();
  }
  ngOnDestroy(): void {
    if (this.opener instanceof HTMLElement && this.opener.isConnected) this.opener.focus();
  }

  protected read(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
  protected confirm(event: Event): void {
    event.preventDefault();
    if (this.matches() && !this.busy()) this.confirmed.emit(this.typed());
  }
  protected cancel(): void {
    if (!this.busy()) this.cancelled.emit();
  }
}
