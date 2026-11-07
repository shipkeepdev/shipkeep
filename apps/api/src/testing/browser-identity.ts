import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from 'playwright';

// Used only inside a callback serialized into Chromium; DOM lib globals stay out of the Node project.
declare const document: { getAnimations: () => { playState: string }[] };

export const FIXTURE_PASSWORD = 'browser fixture passphrase 2026';

/** Respect real progressive throttling; never bypass it with a test provider. */
export async function submit(
  page: Page,
  name: string,
  path: string,
  expected = 200,
): Promise<void> {
  const button = page.getByRole('button', { name, exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === path && response.request().method() === 'POST',
      ),
      button.click(),
    ]);
    if (response.status() !== 429) {
      expect(response.status()).toBe(expected);
      return;
    }
    await page
      .getByRole('alert')
      .getByText('Too many attempts. Wait before trying again.')
      .waitFor();
    expect(await button.isEnabled()).toBe(false);
    await expect.poll(() => button.isEnabled(), { timeout: 70_000 }).toBe(true);
  }
  throw new Error('Browser command remained rate-limited.');
}

export async function mailCode(messages: string[], count: number): Promise<string> {
  await expect.poll(() => messages.length, { timeout: 30_000 }).toBe(count);
  const code = messages
    .at(-1)
    ?.match(/^([A-Za-z0-9_-]{43})$/m)
    ?.at(1);
  if (!code) throw new Error('Fixture mail did not contain a valid code.');
  return code;
}

export async function signIn(
  page: Page,
  email: string,
  password = FIXTURE_PASSWORD,
): Promise<void> {
  await page.goto('/auth/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await fillPrivate(page.getByLabel('Password', { exact: true }), password);
  await submit(page, 'Sign in', '/api/v1/auth/login');
  await page.waitForURL(/\/orgs/);
  await openAccountSecurity(page);
}

/**
 * Sign-in lands on the organization or the list of them. Account security is behind the Account
 * link of the header, outside any organization, or behind the profile at the foot of the sidebar.
 */
export async function openAccountSecurity(page: Page): Promise<void> {
  const header = page.getByRole('link', { name: 'Account', exact: true });
  if (await header.count()) await header.click();
  else
    await page
      .getByRole('link', { name: /2FA|Account/ })
      .last()
      .click();
  await page.getByRole('link', { name: 'Security', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
}

export async function createAccount(page: Page, messages: string[], email: string): Promise<void> {
  const count = messages.length;
  await page.goto('/auth/register');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await fillPrivate(page.getByLabel('Password', { exact: true }), FIXTURE_PASSWORD);
  await submit(page, 'Create account', '/api/v1/auth/register', 202);
  const code = await mailCode(messages, count + 1);
  await page.goto('/verify-email');
  await fillPrivate(page.getByLabel('Verification code', { exact: true }), code);
  await fillPrivate(page.getByLabel('Password', { exact: true }), FIXTURE_PASSWORD);
  await submit(page, 'Verify', '/api/v1/auth/verify', 204);
  await signIn(page, email);
}

/** Entrance animations fade text in; contrast is measured once they are over. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
}

/** Every axe rule, best practices included, naming the rule and the element it found. */
export async function accessibleStrict(page: Page): Promise<void> {
  await settled(page);
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.flatMap(({ id, nodes }) =>
      nodes.map((node) => `${id}: ${String(node.target.at(0))}`),
    ),
  ).toEqual([]);
}

// Playwright failure call logs can include fill arguments. Keep private values out of diagnostics.
export async function fillPrivate(field: Locator, value: string): Promise<void> {
  try {
    await field.fill(value);
  } catch {
    throw new Error('Private field could not be filled.');
  }
}

export async function accessible(page: Page): Promise<void> {
  await settled(page);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  // Report rule IDs, never snapshots that could contain private form values.
  expect(result.violations.map(({ id }) => id)).toEqual([]);
}
