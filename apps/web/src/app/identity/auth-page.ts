import { FocusMonitor } from '@angular/cdk/a11y';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  type ElementRef,
  inject,
  Injector,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { AuthFormStore, isAuthMode, type AuthMode } from './auth-form-store';
import { MutationRunner } from './mutation-runner';

const COPY: Record<AuthMode, { title: string; description: string; action: string }> = {
  login: {
    title: 'Sign in',
    description: 'Access your Shipkeep control plane.',
    action: 'Sign in',
  },
  register: {
    title: 'Create your account',
    description: 'Use an email address you can verify. You will need it to recover access.',
    action: 'Create account',
  },
  'verify-email': {
    title: 'Verify your email',
    description: 'Paste the code from your verification email. The code expires after 24 hours.',
    action: 'Verify email',
  },
  'request-verification': {
    title: 'Send a verification email',
    description: 'Request a fresh code for the email address on your account.',
    action: 'Send verification email',
  },
  'forgot-password': {
    title: 'Reset your password',
    description: 'Enter your account email to request a password-reset code.',
    action: 'Send reset email',
  },
  'reset-password': {
    title: 'Choose a new password',
    description:
      'Use the code from your reset email within 30 minutes. Updating your password signs out your existing sessions.',
    action: 'Update password',
  },
};

@Component({
  selector: 'sk-auth-page',
  imports: [ReactiveFormsModule, RouterLink],
  providers: [AuthFormStore, MutationRunner],
  templateUrl: './auth-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthPage {
  protected readonly store = inject(AuthFormStore);
  protected readonly copy = computed(() => COPY[this.store.mode()]);
  private readonly router = inject(Router);
  private readonly focus = inject(FocusMonitor);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly feedback = viewChild<ElementRef<HTMLElement>>('feedback');
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly factorDetails = viewChild<ElementRef<HTMLDetailsElement>>('factorDetails');

  constructor() {
    inject(ActivatedRoute)
      .data.pipe(takeUntilDestroyed())
      .subscribe((data) => {
        if (isAuthMode(data['mode'])) this.store.configure(data['mode']);
        afterNextRender(
          () => {
            const element = this.heading()?.nativeElement;
            if (element) this.focus.focusVia(element, 'program');
          },
          { injector: this.injector },
        );
      });
  }

  protected async submit(): Promise<void> {
    const destination = await this.store.submit();
    if (this.destroyRef.destroyed) return;
    if (destination) await this.router.navigateByUrl(destination);
    else
      afterNextRender(
        () => {
          const details = this.factorDetails()?.nativeElement;
          if (details && this.store.errorFor('factor')) details.open = true;
          const element = this.feedback()?.nativeElement;
          if (element) this.focus.focusVia(element, 'program');
        },
        { injector: this.injector },
      );
  }
}
