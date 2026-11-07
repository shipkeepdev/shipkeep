import { createHash } from 'node:crypto';

import { TOTP } from 'otpauth';
import type { BrowserContext, Page } from 'playwright';

import { browserApp } from './browser-app';
import {
  accessible,
  createAccount,
  fillPrivate,
  FIXTURE_PASSWORD,
  mailCode,
  openAccountSecurity,
  signIn,
  submit,
} from './browser-identity';

describe('account security in Chromium', () => {
  let fixture: Awaited<ReturnType<typeof browserApp>>;
  let close: (() => Promise<void>) | undefined;
  let context: BrowserContext;
  let page: Page;
  beforeAll(async () => {
    fixture = await browserApp();
    close = fixture.close;
  });
  beforeEach(async () => {
    context = await fixture.newContext();
    page = await context.newPage();
  });
  afterEach(async () => {
    await context.close();
  });
  afterAll(async () => {
    await close?.();
  });

  it('resets a password through delivered mail, invalidates old sessions and rejects code reuse', async () => {
    const email = 'reset-browser@example.com';
    const replacement = 'replacement browser passphrase';
    await createAccount(page, fixture.messages, email);
    const other = await fixture.newContext();
    try {
      await signIn(await other.newPage(), email);
      const count = fixture.messages.length;
      await page.getByRole('link', { name: 'Change your password' }).click();
      await page.getByLabel('Email address').fill(email);
      await submit(page, 'Send reset email', '/api/v1/auth/reset/request', 202);
      const code = await mailCode(fixture.messages, count + 1);
      await page.getByRole('link', { name: 'Enter reset code' }).click();
      await fillPrivate(page.getByLabel('Reset code'), code);
      await fillPrivate(page.getByLabel('New password', { exact: true }), replacement);
      await fillPrivate(page.getByLabel('Confirm password'), FIXTURE_PASSWORD);
      await page.getByRole('button', { name: 'Update password' }).click();
      await page.getByText('Passwords must match.', { exact: true }).waitFor();
      await accessible(page);
      await fillPrivate(page.getByLabel('Confirm password'), replacement);
      await submit(page, 'Update password', '/api/v1/auth/reset', 204);
      await page.getByRole('link', { name: 'Continue to sign in' }).waitFor();
      expect((await other.request.get('/api/v1/auth/session')).status()).toBe(401);
      expect((await context.request.get('/api/v1/auth/session')).status()).toBe(401);
      expect(await page.locator('input[type="password"]').count()).toBe(0);
      await page.goto('/reset-password');
      await fillPrivate(page.getByLabel('Reset code'), code);
      await fillPrivate(page.getByLabel('New password', { exact: true }), replacement);
      await fillPrivate(page.getByLabel('Confirm password'), replacement);
      await submit(page, 'Update password', '/api/v1/auth/reset', 401);
      await page.getByRole('alert').waitFor();
      await page.goto('/auth/login');
      await page.getByLabel('Email address').fill(email);
      await fillPrivate(page.getByLabel('Password', { exact: true }), FIXTURE_PASSWORD);
      await submit(page, 'Sign in', '/api/v1/auth/login', 401);
      await signIn(page, email, replacement);
      expect(page.url().includes(code)).toBe(false);
    } finally {
      await other.close();
    }
  });

  it('recovers one created token after a lost response and throttled retry, then hides its grant', async () => {
    await page.clock.install();
    await createAccount(page, fixture.messages, 'retry-browser@example.com');
    const name = 'report <img src=x onerror=alert(1)>';
    await beginToken(name);
    const attempts: { key: string | undefined; digest: string }[] = [];
    let token = '';
    let replayed = false;
    await page.route('**/api/v1/api-tokens', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      attempts.push({
        key: route.request().headers()['idempotency-key'],
        digest: createHash('sha256')
          .update(route.request().postData() ?? '')
          .digest('hex'),
      });
      // A gateway may throttle the retry even though the first command already committed.
      if (attempts.length === 2)
        return route.fulfill({
          status: 429,
          headers: { 'Retry-After': '1' },
          contentType: 'application/problem+json',
          body: JSON.stringify({ status: 429 }),
        });
      const response = await route.fetch();
      try {
        expect(response.status()).toBe(201);
        const body: unknown = await response.json();
        if (
          !body ||
          typeof body !== 'object' ||
          !('token' in body) ||
          typeof body.token !== 'string'
        )
          throw new Error('Invalid fixture token response.');
        if (attempts.length === 1) {
          token = body.token;
          await route.abort('connectionfailed');
        } else {
          replayed = response.headers()['idempotency-replayed'] === 'true';
          await route.fulfill({ response });
        }
      } finally {
        await response.dispose();
      }
    });
    await page.getByRole('button', { name: 'Create API token', exact: true }).click();
    await page
      .getByRole('alert')
      .getByText('Connection lost. You can retry this request.')
      .waitFor();
    await submit(page, 'Create API token', '/api/v1/api-tokens', 201);
    await page.getByRole('heading', { name: 'Save your API token' }).waitFor();
    expect(attempts.length).toBe(3);
    expect(new Set(attempts.map(({ key }) => key)).size).toBe(1);
    expect(new Set(attempts.map(({ digest }) => digest)).size).toBe(1);
    expect(replayed).toBe(true);
    expect((await page.locator('#new-token').inputValue()) === token).toBe(true);
    await expect.poll(() => page.getByRole('rowheader').count()).toBe(1);
    expect(await page.locator('sk-token-panel img').count()).toBe(0);
    await accessible(page);
    expect(await bearerStatus(token)).toBe(200);
    // Shown once, so no timer may hide it: only an acknowledgement does (WCAG 2.2.1).
    await page.clock.fastForward(600_001);
    await page.getByRole('heading', { name: 'Save your API token' }).waitFor();
    await page.getByRole('button', { name: 'I have saved this token' }).click();
    await page.getByRole('heading', { name: 'Save your API token' }).waitFor({ state: 'hidden' });
    expect(await bearerStatus(token)).toBe(200);
    await page.reload();
    await page.getByRole('button', { name: 'Refresh tokens' }).waitFor();
    expect(await page.locator('#new-token').count()).toBe(0);
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    expect(page.url().includes(token)).toBe(false);
  });

  it('blocks concurrent security writes and discards a grant delivered after route departure', async () => {
    await createAccount(page, fixture.messages, 'departure-browser@example.com');
    await beginToken('Departed request');
    let release: (() => void) | undefined;
    let report: ((status: number) => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committed = new Promise<number>((resolve) => {
      report = resolve;
    });
    await page.route('**/api/v1/api-tokens', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const response = await route.fetch();
      try {
        report?.(response.status());
        await held;
        await route.fulfill({ response });
      } finally {
        await response.dispose();
      }
    });
    try {
      await page.getByRole('button', { name: 'Create API token', exact: true }).click();
      expect(await committed).toBe(201);
      expect(await page.getByRole('button', { name: 'Sign out', exact: true }).isEnabled()).toBe(
        false,
      );
      expect(
        await page.getByRole('button', { name: 'Set up two-factor authentication' }).isEnabled(),
      ).toBe(false);
      await page.getByRole('link', { name: 'Organizations', exact: true }).click();
      await page.getByRole('heading', { name: 'Organizations', exact: true }).waitFor();
      const delivered = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/v1/api-tokens',
      );
      release?.();
      await delivered;
      await page.getByRole('link', { name: 'Account security', exact: true }).click();
      await expect.poll(() => page.getByRole('rowheader').count()).toBe(1);
      expect(await page.locator('#new-token').count()).toBe(0);
      expect(await page.locator('input[type="password"]').count()).toBe(0);
    } finally {
      release?.();
    }
  });

  it('enrolls MFA, rotates sessions/tokens, consumes recovery codes, revokes a token and disables MFA', async () => {
    const email = 'mfa-browser@example.com';
    await page.clock.install();
    await createAccount(page, fixture.messages, email);
    await beginToken('Before MFA');
    await submit(page, 'Create API token', '/api/v1/api-tokens', 201);
    await page.locator('#new-token').waitFor();
    const previousToken = await page.locator('#new-token').inputValue();
    await page.getByRole('button', { name: 'I have saved this token' }).click();
    const other = await fixture.newContext();
    try {
      await signIn(await other.newPage(), email);
      await page.getByRole('button', { name: 'Set up two-factor authentication' }).click();
      await fillPrivate(page.getByLabel('Current password', { exact: true }), FIXTURE_PASSWORD);
      await submit(page, 'Get setup key', '/api/v1/auth/mfa/setup');
      await page.getByLabel('Authenticator setup key').waitFor();
      const seed = await page.getByLabel('Authenticator setup key').inputValue();
      const totp = new TOTP({ secret: seed });
      const enrolledAt = Date.now();
      await fillPrivate(page.getByLabel('Current password', { exact: true }), FIXTURE_PASSWORD);
      await fillPrivate(
        page.getByLabel('Authenticator code', { exact: true }),
        totp.generate({ timestamp: enrolledAt }),
      );
      await submit(page, 'Enable two-factor authentication', '/api/v1/auth/mfa/enable');
      const codes = await recoveryCodes();
      await accessible(page);
      for (const width of [320, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(
          await page
            .getByRole('list', { name: 'Recovery codes' })
            .getByRole('listitem')
            .evaluateAll((items: { scrollWidth: number; clientWidth: number }[]) =>
              items.every((item) => item.scrollWidth <= item.clientWidth),
            ),
        ).toBe(true);
      }
      expect((await other.request.get('/api/v1/auth/session')).status()).toBe(401);
      expect(await bearerStatus(previousToken)).toBe(401);
      await page.getByText('Security settings changed', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'I have saved these codes' }).click();
      await page.getByRole('list', { name: 'Recovery codes' }).waitFor({ state: 'hidden' });
      await submit(page, 'Sign out', '/api/v1/auth/logout', 204);
      const counter = Math.max(Math.floor(Date.now() / 30000), Math.floor(enrolledAt / 30000) + 1);
      await loginWithFactor(email, 'totp', totp.generate({ timestamp: counter * 30000 }));
      await beginToken('With MFA', codes[0]);
      await submit(page, 'Create API token', '/api/v1/api-tokens', 201);
      await page.locator('#new-token').waitFor();
      const token = await page.locator('#new-token').inputValue();
      expect(await bearerStatus(token)).toBe(200);
      await page.getByRole('button', { name: 'I have saved this token' }).click();
      await page.getByRole('button', { name: 'Revoke token With MFA' }).click();
      await proof(codes[0]);
      await submit(
        page,
        'Revoke API token',
        '/api/v1/api-tokens/' + (await tokenId()) + '/revoke',
        401,
      );
      await proof(codes[1]);
      await submit(
        page,
        'Revoke API token',
        '/api/v1/api-tokens/' + (await tokenId()) + '/revoke',
        204,
      );
      await page.getByText('Revoked', { exact: true }).waitFor();
      expect(await bearerStatus(token)).toBe(401);
      await page.getByRole('button', { name: 'Replace recovery codes', exact: true }).click();
      await proof(codes[2]);
      await submit(page, 'Replace recovery codes', '/api/v1/auth/mfa/recovery');
      const replacement = await recoveryCodes();
      expect(replacement.every((code) => !codes.includes(code))).toBe(true);
      // Shown once, so no timer may hide them: only an acknowledgement does (WCAG 2.2.1).
      await page.clock.fastForward(600_001);
      await page.getByRole('list', { name: 'Recovery codes' }).waitFor();
      await page.getByRole('button', { name: 'I have saved these codes' }).click();
      await page.getByRole('list', { name: 'Recovery codes' }).waitFor({ state: 'hidden' });
      await submit(page, 'Sign out', '/api/v1/auth/logout', 204);
      await loginWithFactor(email, 'recovery', codes[3], 401);
      await loginWithFactor(email, 'recovery', replacement[1]);
      await page
        .getByRole('button', { name: 'Disable two-factor authentication', exact: true })
        .click();
      await proof(replacement[0]);
      await submit(page, 'Disable two-factor authentication', '/api/v1/auth/mfa/disable');
      await page.getByText('Not enabled', { exact: true }).waitFor();
      await submit(page, 'Sign out', '/api/v1/auth/logout', 204);
      await signIn(page, email);
    } finally {
      await other.close();
    }
  });

  async function beginToken(name: string, code?: string): Promise<void> {
    await page.getByRole('button', { name: 'Create API token', exact: true }).click();
    await page.getByLabel('Token name').fill(name);
    await fillPrivate(page.getByLabel('Current password', { exact: true }), FIXTURE_PASSWORD);
    if (code) await proof(code);
  }
  async function proof(code: string): Promise<void> {
    await fillPrivate(page.getByLabel('Current password', { exact: true }), FIXTURE_PASSWORD);
    await page.getByLabel('Code type', { exact: true }).selectOption('recovery');
    await fillPrivate(page.getByLabel('Recovery code', { exact: true }), code);
  }
  async function recoveryCodes(): Promise<string[]> {
    const list = page.getByRole('list', { name: 'Recovery codes' });
    await list.waitFor();
    const codes = (await list.getByRole('listitem').allTextContents()).map((code) => code.trim());
    expect(codes.length === 10 && codes.every((code) => /^[a-f0-9]{32}$/.test(code))).toBe(true);
    return codes;
  }
  async function loginWithFactor(
    email: string,
    kind: string,
    code: string,
    expected = 200,
  ): Promise<void> {
    await page.goto('/auth/login');
    await page.getByLabel('Email address').fill(email);
    await fillPrivate(page.getByLabel('Password', { exact: true }), FIXTURE_PASSWORD);
    await page.getByText('Two-factor authentication', { exact: true }).click();
    await page.getByLabel('Code type').selectOption(kind);
    await fillPrivate(
      page.getByLabel(kind === 'totp' ? 'Authenticator code' : 'Recovery code', { exact: true }),
      code,
    );
    await submit(page, 'Sign in', '/api/v1/auth/login', expected);
    if (expected === 200) await openAccountSecurity(page);
  }
  async function bearerStatus(token: string): Promise<number> {
    return (
      await context.request.get('/api/v1/auth/session', {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status();
  }
  async function tokenId(): Promise<string> {
    const response = await context.request.get('/api/v1/api-tokens');
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('items' in body) || !Array.isArray(body.items))
      throw new Error('Invalid token metadata.');
    const item: unknown = body.items.find((item: { name: string }) => item.name === 'With MFA');
    if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string')
      throw new Error('Fixture token was not found.');
    return item.id;
  }
});
