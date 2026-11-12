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
      class="flex max-w-[640px] flex-col gap-3 rounded-[14px] border border-[oklch(0.68_0.17_25/0.5)] bg-black p-5"
    >
      <h2 id="confirm-title" class="text-[15px] font-medium">{{ heading() }}</h2>
      <div id="confirm-description" class="text-[13.5px] leading-[1.55] text-fg3">
        <ng-content />
        {{ typeLabel() }}
        <span class="font-mono text-fg">{{ resourceName() }}</span>
      </div>
      <form (submit)="confirm($event)" class="flex flex-col gap-3">
        <label for="confirm-name" class="sr-only">{{ fieldLabel() }}</label>
        <input
          #field
          id="confirm-name"
          class="input font-mono"
          [placeholder]="fieldLabel()"
          [value]="typed()"
          (input)="typed.set(read($event))"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
        />
        <div class="flex flex-wrap gap-2.5">
          <button
            class="btn font-medium"
            [class.btn-primary]="false"
            [style.background]="matches() && !busy() && !blocked() ? 'oklch(0.68 0.17 25)' : null"
            [style.color]="matches() && !busy() && !blocked() ? '#0B0B0D' : null"
            [style.border-color]="matches() && !busy() && !blocked() ? 'transparent' : null"
            type="submit"
            [disabled]="busy() || blocked() || !matches()"
          >
            {{ busy() ? busyLabel() : actionLabel() }}
          </button>
          <button class="btn btn-sm" type="button" (click)="cancel()">{{ keepLabel() }}</button>
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
  /** Text before the name to type, already translated. */
  readonly typeLabel = input('Type this to confirm:');
  readonly busy = input(false);
  /** The server asked to wait: the action is unavailable, but nothing is running. */
  readonly blocked = input(false);
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
    if (this.matches() && !this.busy() && !this.blocked()) this.confirmed.emit(this.typed());
  }
  protected cancel(): void {
    if (!this.busy()) this.cancelled.emit();
  }
}
