import { FocusMonitor } from '@angular/cdk/a11y';
import {
  afterNextRender,
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { Icon } from '../shell/icon';
import { type IconName } from '../shell/icons';
import { I18n, T } from '../ui/i18n';

import { AccountStore } from './account-store';
import { MfaPanel } from './mfa-panel';
import { MutationRunner } from './mutation-runner';
import { TokenPanel } from './token-panel';

@Component({
  selector: 'sk-account-page',
  imports: [Icon, MfaPanel, RouterLink, T, TokenPanel],
  providers: [AccountStore, MutationRunner],
  templateUrl: './account-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountPage {
  protected readonly store = inject(AccountStore);
  protected readonly i18n = inject(I18n);
  protected readonly sections: readonly { k: string; label: string; icon: IconName }[] = [
    { k: 'account', label: 'Account', icon: 'user' },
    { k: 'security', label: 'Security', icon: 'shield-lock' },
    { k: 'tokens', label: 'API tokens', icon: 'key' },
    { k: 'appearance', label: 'Appearance', icon: 'palette' },
  ];
  private readonly query = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((q) => q.get('section'))),
  );
  protected readonly section = computed(() =>
    this.sections.some((s) => s.k === this.query()) ? (this.query() as string) : 'account',
  );
  protected readonly current = computed(
    () =>
      this.sections.find((s) => s.k === this.section()) ?? {
        k: 'account',
        label: 'Account',
        icon: 'user' as const,
      },
  );
  protected readonly reloadUrl = (): string => globalThis.location.href;
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
