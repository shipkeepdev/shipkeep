import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { AccountStore } from './account-store';
import { MutationRunner } from './mutation-runner';

@Component({
  selector: 'sk-account-page',
  imports: [RouterLink],
  providers: [AccountStore, MutationRunner],
  templateUrl: './account-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountPage {
  protected readonly store = inject(AccountStore);
  private readonly router = inject(Router);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  constructor() {
    afterNextRender(() => {
      this.heading()?.nativeElement.focus();
    });
  }
  protected async signOut(): Promise<void> {
    const destination = await this.store.signOut();
    if (destination) await this.router.navigateByUrl(destination);
  }
}
