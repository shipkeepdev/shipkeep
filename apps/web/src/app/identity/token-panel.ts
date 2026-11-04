import { FocusMonitor } from '@angular/cdk/a11y';
import { DatePipe, TitleCasePipe } from '@angular/common';
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
  untracked,
  viewChild,
} from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';

import { PrivateClipboard } from './private-clipboard';
import { SessionStore } from './session-store';
import { TOKEN_LIFETIMES, TokenFormStore } from './token-form-store';

@Component({
  selector: 'sk-token-panel',
  imports: [DatePipe, TitleCasePipe, ReactiveFormsModule],
  providers: [TokenFormStore, PrivateClipboard],
  templateUrl: './token-panel.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TokenPanel {
  protected readonly store = inject(TokenFormStore);
  protected readonly clipboard = inject(PrivateClipboard);
  protected readonly lifetimes = TOKEN_LIFETIMES;
  protected readonly working = signal(false);
  private readonly session = inject(SessionStore);
  private readonly focus = inject(FocusMonitor);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly pendingTasks = inject(PendingTasks);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly firstField = viewChild<ElementRef<HTMLInputElement>>('firstField');
  private readonly feedback = viewChild<ElementRef<HTMLElement>>('feedback');
  constructor() {
    effect(() => {
      const profile = this.session.profile();
      untracked(() => {
        this.store.resetForSession();
        if (profile) this.pendingTasks.run(() => this.store.refresh());
      });
    });
    effect(() => {
      this.store.credential();
      this.clipboard.reset();
    });
  }
  protected create(): void {
    if (this.store.beginCreate()) this.focusAfterRender('firstField');
  }
  protected revoke(id: string): void {
    if (this.store.beginRevoke(id)) this.focusAfterRender('firstField');
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
  private focusAfterRender(target: 'heading' | 'firstField' | 'feedback'): void {
    afterNextRender(
      () => {
        const element = this[target]()?.nativeElement ?? this.heading()?.nativeElement;
        if (element) this.focus.focusVia(element, 'program');
      },
      { injector: this.injector },
    );
  }
}
