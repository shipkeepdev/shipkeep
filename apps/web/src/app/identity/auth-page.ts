import { FocusMonitor } from '@angular/cdk/a11y';
import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  type ElementRef,
  inject,
  Injector,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { Icon } from '../shell/icon';
import { type IconName } from '../shell/icons';
import { Logo } from '../shell/logo';
import { Brand } from '../ui/brand';
import { I18n, LANGUAGES, T } from '../ui/i18n';
import { Notice } from '../ui/notice';
import {
  AuthFormStore,
  type AuthMode,
  isAuthMode,
  type LoginStep,
  passwordScore,
} from './auth-form-store';
import { AuthOptions } from './auth-options';
import { MutationRunner } from './mutation-runner';

type Screen = Exclude<AuthMode, 'login'> | LoginStep;
interface Copy {
  readonly icon: IconName;
  readonly title: string;
  readonly sub: string;
  readonly cta: string;
  readonly foot: string;
  readonly footLink: string;
  readonly footRoute: string | null;
}

const COPY: Record<Screen, Copy> = {
  password: {
    icon: 'login-2',
    title: 'Welcome back',
    sub: 'Sign in to your control plane.',
    cta: 'Sign in',
    foot: 'No account yet?',
    footLink: 'Create an account',
    footRoute: '/auth/register',
  },
  register: {
    icon: 'user-plus',
    title: 'Create an account',
    sub: 'Then create your organization, or join one when a member adds you.',
    cta: 'Create account',
    foot: 'Already registered?',
    footLink: 'Sign in',
    footRoute: '/auth/login',
  },
  'verify-email': {
    icon: 'mail-opened',
    title: 'Verify your email',
    sub: 'Paste the code from the email we sent you, then confirm with your password.',
    cta: 'Verify',
    foot: 'Nothing received?',
    footLink: 'Resend code',
    footRoute: '/auth/request-verification',
  },
  'request-verification': {
    icon: 'mail-forward',
    title: 'Resend the code',
    sub: 'Enter the email address of your account. We send a new verification code.',
    cta: 'Send code',
    foot: 'Already have a code?',
    footLink: 'Enter it',
    footRoute: '/auth/verify-email',
  },
  totp: {
    icon: 'shield-lock',
    title: 'Two-factor authentication',
    sub: 'Enter the code from your authenticator app.',
    cta: 'Continue',
    foot: 'Lost your device?',
    footLink: 'Use a recovery code',
    footRoute: null,
  },
  recovery: {
    icon: 'key',
    title: 'Recovery code',
    sub: 'Each code works only once.',
    cta: 'Continue',
    foot: '',
    footLink: 'Back to TOTP code',
    footRoute: null,
  },
  'forgot-password': {
    icon: 'lock-question',
    title: 'Forgot password',
    sub: "We'll send you a code to choose a new one.",
    cta: 'Send code',
    foot: 'Remembered it?',
    footLink: 'Sign in',
    footRoute: '/auth/login',
  },
  'reset-password': {
    icon: 'lock-cog',
    title: 'New password',
    sub: 'All your other sessions will be signed out.',
    cta: 'Save',
    foot: '',
    footLink: 'Back to sign in',
    footRoute: '/auth/login',
  },
};

/**
 * The screens that send a message: sign-up, a new confirmation code and a reset link. The screens
 * that redeem a code stay: a code sent before email was turned off still works until it expires,
 * and only the link of that message leads there.
 */
const MAIL_SCREENS: ReadonlySet<Screen> = new Set<Screen>([
  'register',
  'request-verification',
  'forgot-password',
]);
/** Shown in place of those screens on an installation that sends no email (ADR 0020). */
const NO_EMAIL: Copy = {
  icon: 'mail-off',
  title: 'This installation sends no email',
  sub: 'Its administrator creates accounts and resets passwords, on the server that runs Shipkeep.',
  cta: 'Continue to sign in',
  foot: '',
  footLink: '',
  footRoute: null,
};
/** Sign-in on such an installation: it offers neither sign-up nor a reset, and says who does them. */
const NO_EMAIL_SIGN_IN: Copy = {
  ...COPY.password,
  foot: 'No account, or a lost password? Ask the administrator of this installation.',
  footLink: '',
  footRoute: null,
};
/** The confirmation of an address, without the offer to send another code. */
const NO_EMAIL_VERIFY: Copy = {
  ...COPY['verify-email'],
  foot: '',
  footLink: 'Back to sign in',
  footRoute: '/auth/login',
};

const METER = ['', 'weak', 'fair', 'good', 'strong'];

/** Sign-in, sign-up, email verification and password reset, as in the design's auth screens. */
@Component({
  selector: 'sk-auth-page',
  imports: [Brand, Icon, Logo, NgTemplateOutlet, ReactiveFormsModule, RouterLink, T],
  providers: [AuthFormStore, MutationRunner],
  templateUrl: './auth-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthPage {
  protected readonly store = inject(AuthFormStore);
  protected readonly i18n = inject(I18n);
  protected readonly notice = inject(Notice);
  protected readonly languages = LANGUAGES;
  protected readonly screen = computed<Screen>(() =>
    this.store.mode() === 'login' ? this.store.step() : (this.store.mode() as Screen),
  );
  /** Whether this installation sends email; the screens offer only what can work without it. */
  private readonly options = inject(AuthOptions);
  protected readonly sendsEmail = this.options.email;
  protected readonly unavailable = computed(
    () => !this.sendsEmail() && MAIL_SCREENS.has(this.screen()),
  );
  protected readonly copy = computed(() => {
    if (this.unavailable()) return NO_EMAIL;
    if (this.sendsEmail()) return COPY[this.screen()];
    if (this.screen() === 'password') return NO_EMAIL_SIGN_IN;
    return this.screen() === 'verify-email' ? NO_EMAIL_VERIFY : COPY[this.screen()];
  });
  protected readonly score = computed(() => passwordScore(this.store.password()));
  protected readonly meter = computed(() =>
    [0, 1, 2, 3].map((i) => {
      const score = this.score();
      if (i >= score) return 'rgba(255,255,255,0.1)';
      return score <= 1 ? '#bebec2' : score <= 2 ? '#bbbbbf' : '#F2F2F3';
    }),
  );
  protected readonly meterLabel = computed(() => METER[this.score()] ?? '');
  protected readonly digits = computed(() => {
    const code = this.store.factor();
    return [0, 1, 2, 3, 4, 5].map((i) => ({ char: code[i] ?? '', next: i === code.length }));
  });
  protected readonly ssoProviders = [
    { brand: 'github', name: 'GitHub' },
    { brand: 'gitlab', name: 'GitLab' },
  ] as const;
  private readonly router = inject(Router);
  private readonly focus = inject(FocusMonitor);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly feedback = viewChild<ElementRef<HTMLElement>>('feedback');
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly codeInput = viewChild<ElementRef<HTMLInputElement>>('codeInput');

  constructor() {
    inject(ActivatedRoute)
      .data.pipe(takeUntilDestroyed())
      .subscribe((data) => {
        if (isAuthMode(data['mode'])) this.store.configure(data['mode']);
        this.focusHeading();
      });
    this.options.shown();
    // A late answer can remove what someone was using: the form of a screen that sends a message,
    // or the links to sign-up and to the reset on sign-in. Focus that fell back to the page then
    // goes to the heading; focus that was elsewhere stays where it was.
    let answer = this.sendsEmail();
    effect(() => {
      const now = this.sendsEmail();
      if (now === answer) return;
      answer = now;
      afterNextRender(
        () => {
          const active = this.document.activeElement;
          const element = this.heading()?.nativeElement;
          if ((active === null || active === this.document.body) && element)
            this.focus.focusVia(element, 'program');
        },
        { injector: this.injector },
      );
    });
  }

  protected footClick(event: Event): void {
    const step = this.screen();
    if (step !== 'totp' && step !== 'recovery') return;
    event.preventDefault();
    this.store.goTo(step === 'totp' ? 'recovery' : 'totp');
    this.focusHeading();
  }

  protected skip(event: Event): void {
    event.preventDefault();
    const main = (event.target as HTMLElement).ownerDocument.getElementById('main-content');
    main?.focus();
    main?.scrollIntoView();
  }

  protected sso(provider: string): void {
    this.notice.show(
      'Sign-in with {provider} is coming. Use your email and password for now.',
      '',
      {
        provider,
      },
    );
  }

  /** The six boxes mirror one real input, so paste, autofill and screen readers all work. */
  protected typeCode(event: Event): void {
    const input = event.target as HTMLInputElement;
    const clean = input.value.replace(/\D/g, '').slice(0, 6);
    if (clean !== input.value) input.value = clean;
    this.store.form.controls.factor.setValue(clean);
  }

  protected async submit(): Promise<void> {
    const destination = await this.store.submit();
    if (this.destroyRef.destroyed) return;
    if (destination === 'step') {
      this.focusHeading();
      afterNextRender(() => this.codeInput()?.nativeElement.focus(), { injector: this.injector });
    } else if (destination) await this.router.navigateByUrl(destination);
    else
      afterNextRender(
        () => {
          const element = this.feedback()?.nativeElement;
          if (element) this.focus.focusVia(element, 'program');
        },
        { injector: this.injector },
      );
  }

  private focusHeading(): void {
    afterNextRender(
      () => {
        const element = this.heading()?.nativeElement;
        if (element) this.focus.focusVia(element, 'program');
      },
      { injector: this.injector },
    );
  }
}
