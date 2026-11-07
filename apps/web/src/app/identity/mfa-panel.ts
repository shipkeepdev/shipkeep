import { FocusMonitor } from '@angular/cdk/a11y';
import { DatePipe } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  type ElementRef,
  inject,
  Injector,
  PendingTasks,
  signal,
  viewChild,
} from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';

import { T } from '../ui/i18n';

import { MfaFormStore } from './mfa-form-store';
import { PrivateClipboard } from './private-clipboard';

@Component({
  selector: 'sk-mfa-panel',
  imports: [DatePipe, ReactiveFormsModule, T],
  providers: [MfaFormStore, PrivateClipboard],
  templateUrl: './mfa-panel.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MfaPanel {
  protected readonly store = inject(MfaFormStore);
  protected readonly clipboard = inject(PrivateClipboard);
  protected readonly working = signal(false);
  private readonly focus = inject(FocusMonitor);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly password = viewChild<ElementRef<HTMLInputElement>>('password');
  private readonly feedback = viewChild<ElementRef<HTMLElement>>('feedback');
  constructor() {
    inject(PendingTasks).run(() => this.store.load());
    effect(() => {
      this.store.setup();
      this.store.recoveryCodes();
      this.clipboard.reset();
    });
  }
  protected begin(mode: 'setup' | 'disable' | 'recovery'): void {
    if (this.store.begin(mode)) this.focusAfterRender('password');
  }
  protected dismiss(): void {
    this.store.dismiss();
    this.focusAfterRender('heading');
  }
  protected async submit(): Promise<void> {
    if (this.store.submission.busy()) return;
    this.working.set(true);
    try {
      await this.store.submit();
    } finally {
      this.working.set(false);
    }
    if (!this.destroyRef.destroyed && !this.store.submission.problem())
      this.focusAfterRender('feedback');
  }
  private focusAfterRender(target: 'password' | 'heading' | 'feedback'): void {
    afterNextRender(
      () => {
        const element = this[target]()?.nativeElement ?? this.heading()?.nativeElement;
        if (element) this.focus.focusVia(element, 'program');
      },
      { injector: this.injector },
    );
  }
}
