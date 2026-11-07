import { browserApp } from './browser-app';
import { accessible, fillPrivate, openAccountSecurity } from './browser-identity';

// These names are used only inside callbacks serialized into Chromium. Keep DOM lib globals
// out of the Node test project (notably its WebCrypto/X.509 types).
declare const document: {
  addEventListener: (event: string, callback: () => void) => void;
  documentElement: { scrollWidth: number };
  activeElement: unknown;
};
declare const window: object;
declare const innerWidth: number;

describe('production identity in Chromium', () => {
  let fixture: Awaited<ReturnType<typeof browserApp>>;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    fixture = await browserApp();
    close = fixture.close;
  });
  afterAll(async () => {
    await close?.();
  });

  it('boots under CSP, labels public forms and fits desktop, tablet and mobile', async () => {
    const page = await fixture.context.newPage();
    let errors = 0;
    let violations = 0;
    page.on('pageerror', () => errors++);
    await page.exposeFunction('recordCspViolation', () => violations++);
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', () => {
        const callback = Reflect.get(window, 'recordCspViolation') as () => Promise<void>;
        void callback();
      });
    });
    try {
      for (const path of [
        '/auth/login',
        '/auth/register',
        '/verify-email',
        '/auth/request-verification',
        '/auth/forgot-password',
        '/reset-password',
      ]) {
        const response = await page.goto(path);
        expect(response?.status()).toBe(200);
        expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
        await page
          .getByRole('button', {
            name: /^(Sign in|Create account|Verify email|Send verification email|Send reset email|Update password)$/,
          })
          .waitFor();
        await accessible(page);
        for (const width of [320, 390, 768, 1024, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
        }
      }
      await page.goto('/auth/login');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('alert').waitFor();
      await expect
        .poll(() =>
          page.getByRole('alert').evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      await accessible(page);
      expect(errors).toBe(0);
      expect(violations).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('registers, verifies delivered mail, signs in with secure cookies and signs out', async () => {
    const page = await fixture.context.newPage();
    const password = 'browser fixture passphrase 2026';
    const email = 'browser-account@example.com';
    try {
      await page.goto('/auth/register');
      await page.getByLabel('Email address').fill(email);
      await fillPrivate(page.getByLabel('Password', { exact: true }), password);
      await fillPrivate(page.getByLabel('Confirm password'), password);
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await page.getByRole('link', { name: 'Enter verification code' }).waitFor();
      await expect.poll(() => fixture.messages.length, { timeout: 30_000 }).toBe(1);
      const message = fixture.messages.at(0) ?? '';
      const code = message.match(/^([A-Za-z0-9_-]{43})$/m)?.at(1);
      if (!code) throw new Error('Verification mail did not contain a valid code.');
      expect(message.includes(`${fixture.origin}/verify-email`)).toBe(true);
      await page.getByRole('link', { name: 'Enter verification code' }).click();
      await fillPrivate(page.getByLabel('Verification code'), code);
      await fillPrivate(page.getByLabel('Password you chose when signing up'), password);
      await page.getByRole('button', { name: 'Verify email', exact: true }).click();
      await page.getByRole('link', { name: 'Continue to sign in' }).click();
      await page.getByLabel('Email address').fill(email);
      await fillPrivate(page.getByLabel('Password', { exact: true }), password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await openAccountSecurity(page);
      await page
        .getByText('No API tokens yet. Create one when a script or tool needs access.', {
          exact: true,
        })
        .waitFor();
      await accessible(page);

      const cookies = await fixture.context.cookies();
      for (const [name, httpOnly] of [
        ['__Host-shipkeep_session', true],
        ['__Host-shipkeep_csrf', false],
      ] as const) {
        expect(
          cookies.some(
            (cookie) =>
              cookie.name === name &&
              cookie.httpOnly === httpOnly &&
              cookie.secure &&
              cookie.sameSite === 'Strict' &&
              cookie.path === '/',
          ),
        ).toBe(true);
      }
      expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
      expect(
        [password, code, ...cookies.map((cookie) => cookie.value)].some((value) =>
          page.url().includes(value),
        ),
      ).toBe(false);
      const rejected = await page.evaluate(async () => {
        const response = await fetch('/api/v1/auth/logout', {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
        });
        return response.status;
      });
      expect(rejected).toBe(401);
      const foreignOrigin = await fixture.context.request.post('/api/v1/auth/register', {
        headers: { Origin: 'https://untrusted.example.com' },
        data: { email, password },
      });
      expect(foreignOrigin.status()).toBe(403);
      await page.reload();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
      expect(
        (await fixture.context.cookies()).some(
          (cookie) => cookie.name === '__Host-shipkeep_session',
        ),
      ).toBe(false);
      expect((await fixture.context.request.get('/api/v1/auth/session')).status()).toBe(401);
    } finally {
      await page.close();
    }
  });
});
