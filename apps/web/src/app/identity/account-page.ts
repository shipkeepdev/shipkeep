import { FocusMonitor } from '@angular/cdk/a11y';
import {
  afterNextRender,
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { AccountStore } from './account-store';
import { MfaPanel } from './mfa-panel';
import { MutationRunner } from './mutation-runner';

@Component({
  selector: 'sk-account-page',
  imports: [RouterLink, MfaPanel],
  providers: [AccountStore, MutationRunner],
  templateUrl: './account-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountPage {
  protected readonly store = inject(AccountStore);
  private readonly router = inject(Router);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly feedback = viewChild<ElementRef<HTMLElement>>('feedback');
  private readonly focus = inject(FocusMonitor);
  constructor() {
    afterNextRender(() => {
      this.heading()?.nativeElement.focus();
    });
    afterRenderEffect(() => {
      if (!this.store.submission.problem()) return;
      const element = this.feedback()?.nativeElement;
      if (element) this.focus.focusVia(element, 'program');
    });
  }
  protected async signOut(): Promise<void> {
    const destination = await this.store.signOut();
    if (destination) await this.router.navigateByUrl(destination);
  }
}
