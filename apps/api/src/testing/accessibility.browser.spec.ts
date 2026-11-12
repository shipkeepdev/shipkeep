import type { Locator, Page } from 'playwright';

import { browserApp } from './browser-app';
import {
  accessible,
  createAccount,
  fillPrivate,
  FIXTURE_PASSWORD,
  submit,
} from './browser-identity';

// Browser-only globals; do not add DOM types to the Node/WebCrypto test project.
declare const document: { activeElement: unknown };

async function focused(locator: Locator): Promise<void> {
  await expect
    .poll(() => locator.evaluate((element) => element === document.activeElement))
    .toBe(true);
}

describe('identity keyboard access in Chromium', () => {
  let fixture: Awaited<ReturnType<typeof browserApp>>;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    fixture = await browserApp();
    close = fixture.close;
  });
  afterAll(async () => {
    await close?.();
  });

  it('skips navigation without leaving the current form and recovers from keyboard validation', async () => {
    const context = await fixture.newContext();
    const page = await context.newPage();
    try {
      await page.goto('/auth/forgot-password');
      await focused(page.getByRole('heading', { name: 'Forgot password', exact: true }));
      await page.getByLabel('Email', { exact: true }).fill('keyboard@example.com');
      const skip = page.getByRole('link', { name: 'Skip to content' });
      for (let step = 0; step < 6; step++) {
        await page.keyboard.press('Shift+Tab');
        if (await skip.evaluate((element) => element === document.activeElement)) break;
      }
      await focused(skip);
      await page.keyboard.press('Enter');
      await focused(page.getByRole('main'));
      expect(new URL(page.url()).pathname).toBe('/auth/forgot-password');
      expect(await page.getByLabel('Email', { exact: true }).inputValue()).toBe(
        'keyboard@example.com',
      );

      await page.goto('/auth/login');
      await focused(page.getByRole('heading', { name: 'Welcome back', exact: true }));
      let submissions = 0;
      page.on('request', (request) => {
        if (request.method() === 'POST') submissions++;
      });
      await page.keyboard.press('Tab');
      await focused(page.getByLabel('Email', { exact: true }));
      await page.keyboard.press('Tab');
      await focused(page.getByRole('link', { name: 'Forgot?' }));
      await page.keyboard.press('Tab');
      await focused(page.getByLabel('Password', { exact: true }));
      await page.keyboard.press('Tab');
      await focused(page.getByRole('button', { name: 'Sign in', exact: true }));
      await page.keyboard.press('Enter');
      await focused(page.getByRole('alert'));
      await page.keyboard.press('Tab');
      await focused(page.getByLabel('Email', { exact: true }));
      expect(await page.getByLabel('Email', { exact: true }).getAttribute('aria-invalid')).toBe(
        'true',
      );
      expect(submissions).toBe(0);
      await accessible(page);
    } finally {
      await context.close();
    }
  });

  it('exposes narrow token-table actions and supports keyboard scrolling after resize', async () => {
    const context = await fixture.newContext();
    const page: Page = await context.newPage();
    try {
      await createAccount(page, fixture.messages, 'keyboard-tokens@example.com');
      await page.getByRole('link', { name: 'API tokens', exact: true }).click();
      await page.getByRole('button', { name: 'Create API token', exact: true }).click();
      await page.getByLabel('Token name').fill('Keyboard access');
      await fillPrivate(page.getByLabel('Current password'), FIXTURE_PASSWORD);
      await submit(page, 'Create API token', '/api/v1/api-tokens', 201);
      await page.getByRole('button', { name: 'I have saved this token' }).click();
      const region = page.getByRole('region', { name: 'API token list' });
      const hint = page.getByText(
        'Scroll horizontally to see all columns, including token actions.',
        { exact: true },
      );
      for (const width of [1440, 768, 390, 320, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        const overflow = await region.evaluate(
          (element: { scrollWidth: number; clientWidth: number }) =>
            element.scrollWidth > element.clientWidth,
        );
        await expect.poll(() => hint.isVisible()).toBe(overflow);
        if (overflow) {
          expect(await region.getAttribute('aria-describedby')).toBe('token-scroll-hint');
          await region.focus();
          await focused(region);
          await page.keyboard.press('ArrowRight');
          await expect
            .poll(() => region.evaluate((element: { scrollLeft: number }) => element.scrollLeft))
            .toBeGreaterThan(0);
          await page.keyboard.press('Tab');
          await focused(page.getByRole('button', { name: 'Revoke token Keyboard access' }));
        }
      }
      await accessible(page);
    } finally {
      await context.close();
    }
  });
});
